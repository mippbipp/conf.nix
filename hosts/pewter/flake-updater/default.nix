# The Updater (and, when enabled, the Flake fixer) on pewter. See
# docs/adr/0009-flake-update-pipeline.md for the pipeline and runbook.
{
  config,
  globals,
  host,
  lib,
  pkgs,
  username,
  ...
}:
let
  cfg = config.services.flake-updater;
  updater = pkgs.callPackage ./package.nix { };

  stateDir = "/var/lib/flake-updater";
  fixerDir = "/var/lib/flake-fixer";
  workDir = "${fixerDir}/work";
  contextDir = "${fixerDir}/context";
  # Lives in the Updater's 0700 state directory: the Updater reads it, the
  # fixer's server gets it as a systemd credential, the agent never sees it.
  passwordFile = "${stateDir}/fixer-password";
  fixerPort = 4097;

  fixerConfig = pkgs.writeTextDir "opencode/opencode.json" (
    builtins.toJSON (import ./opencode-config.nix { inherit (cfg.agent) model; })
  );

  agentFlags = lib.optionals cfg.agent.enable [
    "--agent"
    "--model"
    cfg.agent.model
    "--agent-url"
    "http://127.0.0.1:${toString fixerPort}"
    "--agent-password-file"
    passwordFile
    "--work-dir"
    workDir
    "--context-dir"
    contextDir
    "--session-url"
    "https://${host}.${globals.tailnet.suffix}:${toString cfg.agent.httpsPort}"
  ];
in
{
  options.services.flake-updater.agent = {
    enable = lib.mkEnableOption "Flake fixer repair rounds when the Build gate is red";
    model = lib.mkOption {
      type = lib.types.str;
      default = "opencode/deepseek-v4.1-flash-free";
      description = ''
        `provider/model` the Flake fixer runs on. Its provider is the only one
        the fixer's server allows, so an unavailable model fails the run
        instead of falling back.
      '';
    };
    httpsPort = lib.mkOption {
      type = lib.types.port;
      default = 8444;
      description = "Tailnet HTTPS port for the fixer server's web UI.";
    };
  };

  config = lib.mkMerge [
    {
      environment.systemPackages = [ updater ];

      systemd = {
        services.flake-updater = {
          description = "Bump flake inputs and maintain the verified update PR";
          serviceConfig = {
            Type = "oneshot";
            User = username;
            StateDirectory = "flake-updater";
            StateDirectoryMode = "0700";
            # Workspace files the Updater writes stay group-writable for the
            # Flake fixer.
            UMask = "0002";
            # Hard stop so a hung run cannot block next Monday's timer; the
            # Updater reports on its own at 11.5 hours.
            TimeoutStartSec = "12h";
            ExecStart = lib.escapeShellArgs (
              [
                (lib.getExe updater)
                "--token-file"
                config.sops.secrets.github_token.path
              ]
              ++ agentFlags
            );
          };
        };
        timers.flake-updater = {
          wantedBy = [ "timers.target" ];
          timerConfig = {
            OnCalendar = "Mon *-*-* 02:00:00";
            Persistent = true;
            RandomizedDelaySec = "30m";
          };
        };
      };
    }

    (lib.mkIf cfg.agent.enable {
      users = {
        users.flake-fixer = {
          isSystemUser = true;
          group = "flake-fixer";
          home = fixerDir;
        };
        # The Updater copies the branch into the workspace and reads it back.
        groups.flake-fixer.members = [ username ];
      };

      systemd = {
        tmpfiles.rules = [
          "d ${stateDir} 0700 ${username} users -"
          "d ${workDir} 2770 flake-fixer flake-fixer -"
          "d ${contextDir} 2770 flake-fixer flake-fixer -"
        ];

        services.flake-fixer-password = {
          description = "Create the Flake fixer server password";
          wantedBy = [ "multi-user.target" ];
          before = [ "flake-fixer.service" ];
          after = [ "systemd-tmpfiles-setup.service" ];
          serviceConfig = {
            Type = "oneshot";
            RemainAfterExit = true;
          };
          script = ''
            if [ ! -s ${passwordFile} ]; then
              umask 077
              ${pkgs.openssl}/bin/openssl rand -base64 32 > ${passwordFile}
              chown ${username}:users ${passwordFile}
            fi
          '';
        };

        services.flake-fixer = {
          description = "opencode server for the Flake fixer (loopback, via Tailscale Serve)";
          wantedBy = [ "multi-user.target" ];
          requires = [ "flake-fixer-password.service" ];
          after = [
            "network-online.target"
            "flake-fixer-password.service"
          ];
          wants = [ "network-online.target" ];
          # What the agent's shell rules allow, plus the revert helper.
          path = [
            updater
            config.nix.package
            pkgs.coreutils
            pkgs.diffutils
            pkgs.gnugrep
            pkgs.gnused
            pkgs.jq
            pkgs.ripgrep
          ];
          environment = {
            HOME = fixerDir;
            # Read-only config: the agent cannot rewrite its own policies, and
            # project config from the workspace is never loaded.
            XDG_CONFIG_HOME = "${fixerConfig}";
            XDG_DATA_HOME = "${fixerDir}/data";
            XDG_STATE_HOME = "${fixerDir}/state";
            XDG_CACHE_HOME = "${fixerDir}/cache";
            OPENCODE_DISABLE_PROJECT_CONFIG = "1";
            OPENCODE_DISABLE_AUTOUPDATE = "1";
            OPENCODE_DISABLE_CLAUDE_CODE = "1";
          };
          script = ''
            OPENCODE_SERVER_PASSWORD="$(< "$CREDENTIALS_DIRECTORY/password")"
            export OPENCODE_SERVER_PASSWORD
            exec ${lib.getExe' pkgs.opencode "opencode"} serve --hostname 127.0.0.1 --port ${toString fixerPort}
          '';
          serviceConfig = {
            User = "flake-fixer";
            Group = "flake-fixer";
            LoadCredential = "password:${passwordFile}";
            UMask = "0002";
            Restart = "always";
            RestartSec = 5;
            StateDirectory = "flake-fixer";
            StateDirectoryMode = "0750";
            # The sandbox is the real boundary: the agent reads untrusted logs
            # and upstream code, so nothing secret may be reachable from it.
            ProtectSystem = "strict";
            ProtectHome = true;
            ReadWritePaths = [
              fixerDir
              "/nix/var/nix/daemon-socket"
            ];
            InaccessiblePaths = [
              "-/run/secrets"
              "-/run/secrets.d"
              "-/run/secrets-for-users"
              "-${stateDir}"
              "-/var/lib/sops-nix"
              "-/etc/secrets"
            ];
            PrivateTmp = true;
            PrivateDevices = true;
            NoNewPrivileges = true;
            ProtectKernelTunables = true;
            ProtectKernelModules = true;
            ProtectControlGroups = true;
            RestrictSUIDSGID = true;
            LockPersonality = true;
            CapabilityBoundingSet = "";
          };
        };
      };

      tailnetExpose.flake-fixer = {
        inherit (cfg.agent) httpsPort;
        backend = "http://127.0.0.1:${toString fixerPort}";
        dependsOn = [ "flake-fixer.service" ];
      };
    })
  ];
}
