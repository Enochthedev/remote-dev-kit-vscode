## Detected, not typed

RDK reads your repo and fills these in:

| | Detected from |
|---|---|
| **Stack** | `manage.py` → Django, else your `Dockerfile` |
| **Port** | the `EXPOSE` line in the Dockerfile |
| **Service** | implied by the stack |
| **URL** | `<project>.<your wildcard domain>` |

So it only asks you two things: the **project name** and the **URL** — both pre-filled.

It writes a single file:

```
.env.remote      ← the only per-project file
```

This is the *same* file the `rdk` CLI reads. Configure it here, and `rdk up` in a terminal does exactly the same thing. It's added to git's exclude list automatically, so your SSH target never gets committed.
