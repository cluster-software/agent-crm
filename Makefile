.PHONY: app-dev app-dev-prod app-dev-help

SYNC ?= local
PORT ?= 8000
APP_REPO ?= ../agent-crm-app
SYNC_REPO ?= ../agent-crm-sync-engine
SKILLS ?=
CLAUDE_SKILLS ?= local
SYNC_URL ?=
SKIP_SYNC_BUILD ?=

app-dev:
	node tools/dev-agent-crm-app.mjs \
		--sync "$(SYNC)" \
		--port "$(PORT)" \
		--app-repo "$(APP_REPO)" \
		--sync-repo "$(SYNC_REPO)" \
		--claude-skills "$(CLAUDE_SKILLS)" \
		$(if $(SKILLS),--skills "$(SKILLS)",) \
		$(if $(SYNC_URL),--sync-url "$(SYNC_URL)",) \
		$(if $(SKIP_SYNC_BUILD),--skip-sync-build,)

app-dev-prod:
	$(MAKE) app-dev SYNC=prod

app-dev-help:
	node tools/dev-agent-crm-app.mjs --help
