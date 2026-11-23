# devorch-plugins

The public Claude Code plugin marketplace for [Dev Orchestrator](https://app.devorchestrator.com).

It holds the `devorch` plugin: the DevOrch MCP tools, the `devorch:step` and `devorch:sdlc-drive` skills, the
`devorch:step-worker` agent, and the companion mod that wakes a session when its run can move.

The plugin needs the `devorch` CLI on PATH:

```
npm i -g dev-orchestrator-cli
devorch plugin install
```

The plugin contents are published here automatically by each CLI release, so plugin and CLI versions move
together. Don't edit them by hand in this repo.

Licensed under the [MIT License](LICENSE).
