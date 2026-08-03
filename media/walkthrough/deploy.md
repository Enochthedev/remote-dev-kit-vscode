## Deploy, then iterate

**Deploy** — builds the image *on the VPS* and starts it. No local Docker daemon, no disk or RAM used on your Mac.

**Watch** — deploys, then live-syncs your edits into the running container. Save a file locally, the remote app reloads.

The sidebar shows what's actually happening:

```
● myapp                    running
  https://myapp.dev.yourdomain.com
  ── Services ──
  ● django                 Up 4 minutes
  ● postgres               Up 4 minutes
  ○ celeryworker           Exited (1)     ← click for its logs
```

Two ways to take it down:

- **Stop** — containers off, **database kept**.
- **Destroy** — images *and* volumes deleted. Asks first, and tells you exactly what you lose.
