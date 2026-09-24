{
  pkgs,
  globals,
  host,
  config,
  ...
}:
let
  karakeep_port = "3000";
  tail_port = "3434";
  url = "https://${host}.${globals.tailnet.suffix}:${toString tail_port}";
in
{
  # AI tagging via free OpenRouter models. OPENAI_API_KEY in SOPS
  sops.secrets.karakeep_openrouter_env = {
    owner = "root";
    restartUnits = [
      "karakeep-web.service"
      "karakeep-workers.service"
    ];
  };

  services.karakeep = {
    enable = true;
    meilisearch.enable = true;
    browser.enable = true;
    environmentFile = config.sops.secrets.karakeep_openrouter_env.path;
    extraEnvironment = {
      PORT = karakeep_port;
      NEXTAUTH_URL = url;
      DISABLE_SIGNUPS = "true"; # disabled after first user signup
      DISABLE_NEW_RELEASE_CHECK = "true";
      OPENAI_BASE_URL = "https://openrouter.ai/api/v1";
      INFERENCE_TEXT_MODEL = "nex-agi/nex-n2.5-mini:free";
      INFERENCE_IMAGE_MODEL = "nex-agi/nex-n2.5-mini:free";
      INFERENCE_OUTPUT_SCHEMA = "structured";
      INFERENCE_ENABLE_AUTO_SUMMARIZATION = "false";
      EMBEDDING_ENABLE_AUTO_INDEXING = "false";
    };
  };

  # tailscaled terminates tailnet TLS on :{port} and proxies
  # to the loopback backend. `--bg` is load-bearing (without it serve stays in
  # the foreground and the oneshot times out). Mapping persists in tailscaled
  # state until `tailscale serve --https={port} off`.
  systemd.services.karakeep-serve = {
    description = "Karakeep via Tailscale Serve HTTPS :${tail_port}";
    wantedBy = [ "multi-user.target" ];
    after = [
      "tailscaled.service"
      "tailscaled-set.service"
      "karakeep-web.service" # nixos service
    ];
    partOf = [ "tailscaled.service" ];
    path = [ pkgs.tailscale ];
    # tailscaled is systemd-active before its backend reaches Running, so the
    # first serve call can transiently fail with NoState. Retry indefinitely.
    unitConfig.StartLimitIntervalSec = 0;
    script = ''
      tailscale serve --yes --bg --https=${tail_port} http://127.0.0.1:${karakeep_port}
    '';
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      Restart = "on-failure";
      RestartSec = 2;
    };
  };
}
