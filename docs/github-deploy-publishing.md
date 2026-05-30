# GitHub-owned image publishing

This repo keeps feature work and PR integration on Forgejo, but deployable Postiz images are published from GitHub after the release ref is mirrored there.

## Target flow

1. Work happens on Forgejo feature branches against `dev/all-open-prs-preview`.
2. The integrator merges preview/release work to `main`.
3. `main` is mirrored to GitHub.
4. GitHub Actions runs the `Build` workflow for `main`.
5. After build succeeds, GitHub publishes immutable multi-arch image tags:
   - `ghcr.io/<github-owner>/postiz-app:sha-<full>`
   - `ghcr.io/<github-owner>/postiz-app:sha-<short>`
6. A manual promotion retags an already-published SHA image to `staging` or `prod`.
7. Deploy hosts pull only promoted tags. They must not build images during deploy.

## Required GitHub configuration

- Packages write permission for GitHub Actions.
- Optional repository variable `IMAGE_NAME`; defaults to `postiz-app`.
- An ARM runner with label `ubuntu-24.04-arm` if multi-arch publishing stays enabled.

## Follow-up cutover checklist

- Mirror Forgejo `main` and promotion tags/refs to GitHub reliably.
- Update Terraform or deploy manifests to pull `ghcr.io/<github-owner>/postiz-app:staging` and `:prod`.
- Update host registry credentials so Docker can pull from GHCR.
- SSH to deploy hosts, verify `docker login ghcr.io`, pull the promoted image, restart Postiz, and check application health.
- Decide whether PR image publishing from `pull_request_target` is still needed; remove it if not required.
- Stop using `latest` as a deployment input. Deploy from `staging` or `prod` only.
