# P13: Bootstrap / fresh-install / singleton lock / platforms

> Status: **Accepted** (0.3.0 wire-freeze gate)
> Normative parent: [rfc-0.3.0-control-plane.md](../rfc-0.3.0-control-plane.md) v7.7

## Decision
### controlMode
| Mode | Behavior |
| auto (default) | Ensure registry + project store; start/attach user singleton multi-mount; fail closed |
| coordinated | External control required; fail closed if down |
| standalone | **Explicit only**; in-process ControlHost; same project store |

**Silent auto→standalone is forbidden.**

### Singleton (D32)
Embedded multi-mount competes for the **same** user lock + endpoint as taskflowd.
Losers attach; must not fork independent multi-mount authority.

### Platforms
- **Unix UDS** required for 0.3 GA.
- **Windows named pipe**: **non-GA** in 0.3; release notes must say so. Lock-file coordination still applies.

### Layout
- User: `~/.taskflow/control/` (overridable via TASKFLOW_HOME)
- Project: `<root>/.taskflow/control/`
- The singleton lock stores the exact effective endpoint. When the user control root would exceed the Unix `sockaddr_un` limit, the UDS moves deterministically to an owner-private, user-root-hashed temporary directory; authority, authentication, fencing and the durable lock remain unchanged. Silent kernel path truncation is forbidden.

## Status
Accepted for 0.3.0 wire freeze.
