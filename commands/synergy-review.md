---
description: Start or resume a guided Synergy review and connect browser questions to the agent
argument-hint: --pr <number-or-url> | --staged | --unstaged | --scope <path> | --resume <workspace@revision>
---

Invoke the `synergy:review` skill with the user's request unchanged:

`$ARGUMENTS`

Examples: `/synergy-review --pr 317`, `/synergy-review --staged`,
`/synergy-review --unstaged`, `/synergy-review --scope features/subscriptions`, or
`/synergy-review --resume <workspace@revision>`.

The shared skill owns capture, repository-aware analysis, explicit preview startup,
runtime-authoritative review URLs, and the durable browser-question loop. Follow it exactly;
do not reproduce that workflow in this command.
