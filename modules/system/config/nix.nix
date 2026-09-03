{ username, globals, ... }:
{
  nixpkgs.config = {
    allowUnfree = true;
  };
  environment.sessionVariables = {
    NIXPKGS_ALLOW_UNFREE = "1"; # for one-off commands like `nix-shell`
  };

  # Optimization settings and garbage collection automation
  nix = {
    settings = {
      auto-optimise-store = true;
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      # Owned by globals.cache; the attic-cache-sync check pins the CI copy.
      substituters = globals.cache.substituters;
      trusted-public-keys = globals.cache.trustedKeys;
      trusted-users = [ username ];
    };
    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 7d";
    };
  };

}
