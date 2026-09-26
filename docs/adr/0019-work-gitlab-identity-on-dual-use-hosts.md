# Work GitLab identity on dual-use hosts via a work-only sops file

`warpe`, `hector`, and `pewter` carry the work GitLab identity (`anthony`, work email, dedicated per-host SSH key for auth and signing) gated to `~/work/` checkouts by a conditional git include, with personal identity remaining the global default. Work values live in a second sops file with its own age recipient held only on those three hosts; the company hostname travels solely through runtime `/run/secrets` paths (git include, ssh top-level `Include`, `GITLAB_HOST`), so it never appears in the public repo.

Considered and rejected: prefixing work secrets inside the shared `secrets/me.yaml` (sprays work values onto `gram` and `harpe`), one shared work private key in sops (per-host local-only keypairs with GitLab registrations instead), hostname-plaintext config, and HTTPS tokens for git transport. The PAT exists only for `glab` API calls via `GITLAB_TOKEN`.

Consequences: `hector` imports only the work sops module and stays personal-secret-free; `warpe` and `pewter` hold both age keys. The sops module guards on `secrets/work.yaml` existing (same `builtins.pathExists` pattern as `hosts/warpe/work.nix`), so the work identity is inert with a warning until rollout provisions the file, and the Build gate stays green throughout. Rollout is manual in this order: generate the work age key, add its recipient to `.sops.yaml` for `secrets/work.yaml` only, create that file (see template below), install the key on all three hosts, `ssh-keygen` per host plus GitLab registration and SSO-authorize, create the PAT, then rebuild. Provision before cloning work repos: an inert module means `~/work/` commits would otherwise carry the personal identity.

`secrets/work.yaml`:

```yaml
work_gitconfig: |
  [user]
    name = anthony
    email = <work-email>
    signingkey = ~/.ssh/work_ed25519.pub
  [commit]
    gpgsign = true
  [tag]
    gpgsign = true
work_ssh_config: |
  Host <company-gitlab-host>
    HostName <company-gitlab-host>
    User git
    IdentityFile ~/.ssh/work_ed25519
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
work_gitlab_host: https://<company-gitlab-host>
# API token for glab (GITLAB_TOKEN). Fine-grained preferred over legacy:
# grant it read/write on Merge requests and Issues, read on Repository,
# Pipelines, and User, scoped to the work group/project. Permissions are
# immutable — rotation keeps them — so if a glab command 403s (GitLab's error
# names the missing permission), create a new token with it, swap it in here,
# rebuild, verify, then revoke the old one.
work_gitlab_token: <token>
```

Status: accepted
