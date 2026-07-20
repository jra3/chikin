# chikin — common fleet operations. First-time setup is ./install.sh.
# Everything runs on this one host in containers (fleet-only, local-only).

COMPOSE = docker compose
DEV     = docker compose -f docker-compose.yml -f docker-compose.dev.yml

.PHONY: pull up down update verify dev-build dev-up uninstall purge

# Fetch the pinned gateway + fleet browser images from ghcr (builds nothing).
pull:
	$(COMPOSE) --profile build pull

# Start / stop the control plane (down keeps profile volumes).
up:
	$(COMPOSE) up -d
down:
	$(COMPOSE) down

# Pull newer pinned images, restart, and refresh the client bridge deps.
# Run `git pull` first to move CHIKIN_VERSION / code forward.
update: pull up
	cd client && npm install --omit=dev

# Prove a fleet browser is non-headless by driving one through the gateway MCP.
verify:
	cd verify && npm install --silent && node verify-fleet.js

# Developer path: build both images locally instead of pulling.
dev-build:
	$(DEV) --profile build build
dev-up:
	$(DEV) up -d

# Teardown. uninstall preserves logged-in profile volumes; purge wipes them.
uninstall:
	./install.sh --uninstall
purge:
	./install.sh --purge
