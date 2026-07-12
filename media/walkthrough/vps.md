## One VPS, every project

```
  Your Mac                    Your VPS
  ────────                    ────────
  code (stays here)  ──ssh──▶ docker build
  docker CLI                  traefik ──▶ https://myapp.dev.yourdomain.com
```

You answer two things **once**:

| | |
|---|---|
| **SSH target** | `root@203.0.113.10` |
| **Wildcard domain** | `dev.yourdomain.com` |

RDK then SSHes in and works out the rest itself — whether Docker is installed, whether you already run a Coolify/Traefik proxy, and which cert resolver it uses.

Every project after this one reuses all of it.
