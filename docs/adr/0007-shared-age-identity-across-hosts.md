# One shared age identity for all hosts

All NixOS hosts decrypt the same `secrets.yaml` with the same age identity (now at `/var/lib/sops-nix/keys.txt`, see ADR 0008; originally `~/.config/sops/age/keys.txt`), sole recipient in `.sops.yaml`, copied manually to each host. Per-host identities were considered and rejected.

Why shared: the secrets are personal credentials (GitHub token, git config) whose blast radius already spans every host — they belong to the same person on every machine. At the time of writing, decryption ran via the home-manager module as the user, so the NixOS pattern of deriving per-host keys from root-owned SSH host keys seemed inapplicable; user-level keys had to be generated and distributed by hand either way, and a single identity made that ceremony zero: no `.sops.yaml` edits, no `sops updatekeys` when machines come and go. (ADR 0008 later moved decryption to the NixOS module with a root-owned key; per-host identities remain rejected for the same ceremony reason.)

Cost accepted: compromising any one host's key exposes all secrets, and revoking one host means re-keying every host. Revisit if secrets ever appear that should not be readable from a specific host — warpe (work machine) is the likeliest trigger.

Status: accepted
