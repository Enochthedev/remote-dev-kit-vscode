import * as vscode from "vscode";
import * as path from "path";
import { randomBytes } from "crypto";
import { Defaults, getDefaults, loadConfig, saveDefaults } from "./config";
import { composeServices, detectBaseCompose, detectProject, probeVps, slug } from "./detect";
import { ensureIgnored, envExists, writeEnv } from "./env";

const SSH_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.:_-]+$/;
const HOST_RE = /^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type StackChoice = "generic" | "generic-db" | "django";

const COMPOSE_FILES: Record<StackChoice, string> = {
  generic: "docker-compose.remote.yml",
  "generic-db": "docker-compose.remote-db.yml",
  django: "docker-compose.django.yml",
};

/** Prompt for one value, pre-filled and validated. Returns undefined if the user escapes. */
async function ask(opts: {
  title: string;
  step: number;
  total: number;
  prompt: string;
  value?: string;
  placeholder?: string;
  validate?: (v: string) => string | undefined;
}): Promise<string | undefined> {
  const v = await vscode.window.showInputBox({
    title: opts.title,
    prompt: opts.prompt,
    value: opts.value,
    placeHolder: opts.placeholder,
    ignoreFocusOut: true,
    validateInput: opts.validate ? (x) => opts.validate!(x.trim()) : undefined,
  });
  return v?.trim();
}

/**
 * Ask for the machine-level values once, ever. Everything here is shared by every project,
 * so a second project never sees these steps again.
 */
export async function setupDefaults(force = false): Promise<Defaults | undefined> {
  const cur = getDefaults();
  if (!force && cur.vpsSsh && cur.baseDomain) return cur;

  const title = "Remote Dev Kit — VPS setup (once for all projects)";

  const vpsSsh = await ask({
    title,
    step: 1,
    total: 3,
    prompt: "SSH target for your VPS. Must already work passwordlessly (key-based).",
    value: cur.vpsSsh,
    placeholder: "root@203.0.113.10",
    validate: (v) => (SSH_RE.test(v) ? undefined : "Expected user@host, e.g. root@203.0.113.10"),
  });
  if (!vpsSsh) return undefined;

  // Probe before asking anything else — most of the remaining answers come from the VPS itself.
  const probe = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Checking ${vpsSsh}…` },
    () => probeVps(vpsSsh),
  );

  if (!probe.reachable) {
    const pick = await vscode.window.showErrorMessage(
      `Can't reach ${vpsSsh} over SSH. ${probe.error ?? ""}`,
      "Copy SSH key…",
      "Continue anyway",
    );
    if (pick === "Copy SSH key…") {
      const t = vscode.window.createTerminal({ name: "rdk: ssh-copy-id" });
      t.show();
      t.sendText(`ssh-copy-id ${vpsSsh}`);
      return undefined;
    }
    if (pick !== "Continue anyway") return undefined;
  } else if (!probe.hasDocker) {
    vscode.window.showWarningMessage(`Connected to ${vpsSsh}, but Docker isn't installed there.`);
  }

  const baseDomain = await ask({
    title,
    step: 2,
    total: 3,
    prompt: "Wildcard domain pointing at the VPS. Each project becomes <project>.<domain>.",
    value: cur.baseDomain,
    placeholder: "dev.yourdomain.com",
    validate: (v) => (HOST_RE.test(v) ? undefined : "Expected a domain, e.g. dev.yourdomain.com"),
  });
  if (!baseDomain) return undefined;

  // ACME email only matters when the kit runs its own Traefik.
  let acmeEmail = cur.acmeEmail;
  if (probe.proxyMode === "bare") {
    const v = await ask({
      title,
      step: 3,
      total: 3,
      prompt: "Let's Encrypt contact email (this VPS has no proxy yet, so RDK will run Traefik).",
      value: cur.acmeEmail,
      placeholder: "you@example.com",
      validate: (v) => (EMAIL_RE.test(v) ? undefined : "Expected an email address"),
    });
    if (!v) return undefined;
    acmeEmail = v;
  }

  const d: Defaults = {
    vpsSsh,
    baseDomain,
    acmeEmail,
    proxyNetwork: probe.proxyNetwork,
    certResolver: probe.certResolver,
    certEntrypoint: probe.certEntrypoint,
  };
  await saveDefaults(d);

  vscode.window.showInformationMessage(
    probe.proxyMode === "coolify"
      ? `VPS ready. Detected an existing Coolify proxy — RDK will route through it (network "coolify").`
      : `VPS ready. No proxy detected — RDK will run its own Traefik on network "web".`,
  );

  return d;
}

export interface SetupResult {
  root: string;
  created: boolean;
}

/**
 * Set up the current folder: detect the stack, reuse the global VPS defaults, write a
 * complete .env.remote and keep it out of git. Only asks what it genuinely can't infer.
 */
export async function setupProject(root: string, opts: { reconfigure?: boolean } = {}): Promise<SetupResult | undefined> {
  const shape = detectProject(root);

  if (!shape.deployable) {
    const pick = await vscode.window.showWarningMessage(
      `Remote Dev Kit builds a Docker image, but ${shape.reason.toLowerCase()}`,
      "Set up anyway",
      "Cancel",
    );
    if (pick !== "Set up anyway") return undefined;
  }

  if (envExists(root) && !opts.reconfigure) {
    const pick = await vscode.window.showWarningMessage(
      ".env.remote already exists here.",
      "Overwrite",
      "Open it",
      "Cancel",
    );
    if (pick === "Open it") {
      await openEnvFile(root);
      return undefined;
    }
    if (pick !== "Overwrite") return undefined;
  }

  const defaults = await setupDefaults();
  if (!defaults) return undefined;

  const existing = loadConfig(root);
  const title = `Remote Dev Kit — ${path.basename(root)}`;

  const projectName = await ask({
    title,
    step: 1,
    total: 2,
    prompt: "Project name — namespaces the containers, volumes and subdomain.",
    value: slug(existing?.projectName || path.basename(root)),
    validate: (v) => (v && slug(v) === v ? undefined : "Lowercase letters, numbers, dash and underscore only"),
  });
  if (!projectName) return undefined;

  const suggestedHost = `${projectName}.${defaults.baseDomain}`;
  const appHost = await ask({
    title,
    step: 2,
    total: 2,
    prompt: "Public URL for this project.",
    value: existing && !existing.appHost.includes("example.com") ? existing.appHost : suggestedHost,
    validate: (v) => (HOST_RE.test(v) ? undefined : "Expected a hostname, e.g. myapp.dev.yourdomain.com"),
  });
  if (!appHost) return undefined;

  // If the project has its own compose file, that file is the source of truth. RDK layers its
  // proxy + TLS labels on top rather than shipping a rival definition of the same services.
  const base = detectBaseCompose(root);
  if (base) {
    const services = composeServices(root, base);
    const useOverlay = await vscode.window.showQuickPick(
      [
        {
          label: `$(check) Use my ${base}`,
          detail: services.length
            ? `RDK adds only the proxy network + TLS labels. Your services: ${services.join(", ")}`
            : "RDK adds only the proxy network and TLS labels — it won't redefine your services.",
          value: "overlay",
        },
        {
          label: "$(package) Use a bundled stack instead",
          detail: "RDK builds a single web service from your Dockerfile and ignores your compose file.",
          value: "stack",
        },
      ],
      { title: `${title} — found ${base}`, ignoreFocusOut: true },
    );
    if (!useOverlay) return undefined;

    if (useOverlay.value === "overlay") {
      // APP_SERVICE cannot be guessed — it's whichever of THEIR services faces the web.
      let appService: string | undefined;
      if (services.length) {
        const picked = await vscode.window.showQuickPick(
          services.map((s) => ({ label: s })),
          { title: "Which service serves the web?", ignoreFocusOut: true },
        );
        appService = picked?.label;
      } else {
        appService = await ask({
          title,
          step: 1,
          total: 1,
          prompt: `Which service in ${base} serves the web?`,
          placeholder: "web",
          validate: (v) => (v ? undefined : "Required"),
        });
      }
      if (!appService) return undefined;

      writeEnv(root, {
        projectName,
        appHost,
        appPort: shape.appPort,
        appService,
        composeFile: "",
        appDockerfile: "",
        baseCompose: base,
        vpsSsh: defaults.vpsSsh,
        proxyNetwork: defaults.proxyNetwork,
        acmeEmail: defaults.acmeEmail,
        certResolver: defaults.certResolver,
        certEntrypoint: defaults.certEntrypoint,
      });

      await finish(root, projectName, appHost);
      return { root, created: true };
    }
  }

  // Everything below is inferred — the user confirms rather than types it.
  const stackLabel = shape.stack === "django" ? "Django (postgres, redis, celery, mailpit)" : "Generic (single web service)";
  const confirm = await vscode.window.showQuickPick(
    [
      {
        label: "$(check) Looks right — set it up",
        detail: `${stackLabel} · port ${shape.appPort} · ${shape.appDockerfile}`,
        value: "go",
      },
      {
        label: "$(settings-gear) Change stack or port…",
        detail: shape.reason,
        value: "edit",
      },
    ],
    { title: `${title} — detected settings`, ignoreFocusOut: true, placeHolder: shape.reason },
  );
  if (!confirm) return undefined;

  let stack: StackChoice = shape.stack;
  let appPort = shape.appPort;
  let appService = shape.appService;
  let appDockerfile = shape.appDockerfile;

  if (confirm.value === "edit") {
    const picked = await vscode.window.showQuickPick(
      [
        { label: "Generic", detail: "One web service built from your Dockerfile (any language).", value: "generic" },
        {
          label: "Generic + Postgres/Redis",
          detail: "The same, plus a database and cache. Reachable at <project>-postgres / <project>-redis.",
          value: "generic-db",
        },
        { label: "Django", detail: "Cookiecutter-Django: postgres, redis, celery, mailpit, flower.", value: "django" },
      ],
      { title: "Which stack?", ignoreFocusOut: true },
    );
    if (!picked) return undefined;
    stack = picked.value as StackChoice;
    appService = stack === "django" ? "django" : "app";
    appDockerfile = stack === "django" ? "./compose/local/django/Dockerfile" : "./Dockerfile";

    const port = await ask({
      title,
      step: 1,
      total: 1,
      prompt: "Port your app listens on inside the container.",
      value: String(appPort),
      validate: (v) => (/^\d{2,5}$/.test(v) && Number(v) < 65536 ? undefined : "Expected a port number"),
    });
    if (!port) return undefined;
    appPort = Number(port);
  }

  writeEnv(root, {
    projectName,
    appHost,
    appPort,
    appService,
    composeFile: COMPOSE_FILES[stack],
    appDockerfile,
    vpsSsh: defaults.vpsSsh,
    proxyNetwork: defaults.proxyNetwork,
    acmeEmail: defaults.acmeEmail,
    certResolver: defaults.certResolver,
    certEntrypoint: defaults.certEntrypoint,
    // Generated, not asked for — it's a machine secret, not a decision.
    redisPassword: stack === "generic-db" ? randomBytes(24).toString("base64url") : undefined,
  });

  await finish(root, projectName, appHost);
  return { root, created: true };
}

async function finish(root: string, projectName: string, _appHost: string): Promise<void> {
  const ignored = await ensureIgnored(root);

  const pick = await vscode.window.showInformationMessage(
    `Remote Dev Kit is set up for ${projectName}.${ignored ? " .env.remote is git-ignored." : ""}`,
    "Deploy now",
    "Review .env.remote",
  );
  if (pick === "Deploy now") {
    await vscode.commands.executeCommand("rdk.deploy", { root });
  } else if (pick === "Review .env.remote") {
    await openEnvFile(root);
  }
}

export async function openEnvFile(root: string): Promise<void> {
  const uri = vscode.Uri.file(path.join(root, ".env.remote"));
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
}
