{
  pkgs,
  globals,
  host,
  config,
  ...
}:
let
  port = 3434;
  url = "https://${host}.${globals.tailnet.suffix}:${toString port}";
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
      PORT = "3000";
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

  # tailscaled terminates tailnet TLS on :3434 and proxies
  # to the loopback backend. `--bg` is load-bearing (without it serve stays in
  # the foreground and the oneshot times out). Mapping persists in tailscaled
  # state until `tailscale serve --https=3434 off`.
  systemd.services.karakeep-serve = {
    description = "Karakeep via Tailscale Serve HTTPS :${toString port}";
    wantedBy = [ "multi-user.target" ];
    after = [
      "tailscaled.service"
      "tailscaled-set.service"
      "karakeep-web.service"
    ];
    partOf = [ "tailscaled.service" ];
    path = [ pkgs.tailscale ];
    script = ''
      tailscale serve --yes --bg --https=${toString port} http://127.0.0.1:3000
    '';
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
  };
}
