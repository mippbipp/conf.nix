# skills-sync

Pull-only mirror of `~/.agents/skills` (remote `git@github.com:mippbipp/skills.git`). A user timer runs `git pull --ff-only` every 5 minutes, starting 2 minutes after boot. `--ff-only` fails loud on dirty state instead of merging, and the unit skips hosts where the repo was never cloned (`ConditionPathExists` on `~/.agents/skills/.git`).

## SSH key selection

The pull script uses `~/.ssh/<host>_skills_ed25519` when that file exists, else the per-host `~/.ssh/<host>_ed25519` key. Most hosts need nothing: their per-host key already reaches GitHub. A host without personal GitHub access needs its own read-only deploy key under the override path.

## Host without personal access (currently hector)

hector carries no personal credentials by design, so it cannot pull with a normal GitHub key. Give it a deploy key that never leaves the machine:

```bash
ssh-keygen -t ed25519 -N "" -C "hector-skills-deploy" -f ~/.ssh/hector_skills_ed25519
ssh-keyscan github.com >> ~/.ssh/known_hosts
```

Register the public half as a read-only deploy key on the skills repo (repo Settings, Deploy keys, leave write access off), or from a machine with `gh` authed:

```bash
ssh hector -- cat ~/.ssh/hector_skills_ed25519.pub > /tmp/hector-skills.pub
gh repo deploy-key add /tmp/hector-skills.pub --repo mippbipp/skills --title hector-skills-read
shred -u /tmp/hector-skills.pub
```

Then clone on hector and check the timer picks it up:

```bash
GIT_SSH_COMMAND="ssh -i ~/.ssh/hector_skills_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes" git clone git@github.com:mippbipp/skills.git ~/.agents/skills
systemctl --user start skills-sync.service
journalctl --user -u skills-sync -n 20
```

The key stays out of the repo and out of sops. To rotate it, delete the deploy key on GitHub and run these steps again.
