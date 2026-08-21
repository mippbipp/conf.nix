# Secrets decrypt into tmpfs via the NixOS sops module

Decryption moved from the home-manager sops module to `inputs.sops-nix.nixosModules.sops` (`modules/system/config/sops.nix`, wired into every host via `mkHostConfig`). The NixOS service decrypts into tmpfs at `/run/secrets` as root; the shared age identity lives root-owned (0400) at `/var/lib/sops-nix/keys.txt`. Secrets set `owner = username` so user processes can read them. HM consumers get paths through `sopsSecrets` in `extraSpecialArgs`.

Why: under the HM module, plaintext persisted on disk at `$HOME/.config/sops-nix/secrets` next to a user-readable key, so any compromise of the user session exposed both the key and the materialized secrets. With the NixOS module, plaintext exists only in RAM (`/run` is tmpfs, wiped at reboot), and a compromised user session can read already-materialized secrets but can no longer re-decrypt ciphertext. The repo threat model is unchanged: clones and remote builds still carry ciphertext only.

Cost accepted: decryption is now a boot-time dependency — a host without its key fails the `sops-nix` service instead of HM activation, and consumers referencing `/run/secrets` break until that service has run once after provisioning. Each existing host needs a one-time manual migration: copy the old `~/.config/sops/age/keys.txt` to `/var/lib/sops-nix/keys.txt` with `install -Dm400`, then rebuild.

Status: accepted
