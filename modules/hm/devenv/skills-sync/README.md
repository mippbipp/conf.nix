# skills-sync

Pull-only mirror of `~/.agents/skills` (remote `git@github.com:mippbipp/skills.git`). A user timer runs `git pull --ff-only` every 5 minutes, starting 2 minutes after boot. `--ff-only` fails loud on dirty state instead of merging, and the unit skips hosts where the repo was never cloned (`ConditionPathExists` on `~/.agents/skills/.git`).

## SSH key selection

The pull script uses `~/.ssh/<host>_skills_ed25519` when that file exists, else the per-host `~/.ssh/<host>_ed25519` key. Most hosts need nothing: their per-host key already reaches GitHub. A host without personal GitHub access needs its own read-only deploy key under the override path.
