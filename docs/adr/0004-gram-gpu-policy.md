# Gram renders iGPU-default with per-app dGPU opt-in

gram's default renderer is the iGPU (Intel UHD); the dGPU (RTX 3060) is used only for per-app offload launches (`__NV_PRIME_RENDER_OFFLOAD=1` + `__GLX_VENDOR_LIBRARY_NAME=nvidia`, PRIME render offload) and for the home HDMI monitor, whose jack is hard-wired to the dGPU on the GIGABYTE G5 KC. While that monitor is active the dGPU stays powered — Windows behaves the same way on this laptop — and at work (USB-C dock, iGPU-wired) the dGPU deep-sleeps via fine-grained power management when no offloaded app runs.

NVIDIA session-wide environment forcing is therefore wrong by policy, not by accident: the whole point of the setup is that the iGPU owns everything unless an app explicitly opts into the dGPU. Offload launch variables belong to individual launches only.

Considered and rejected: prime sync (dGPU always on — wastes ~17W idle for no opt-in control) and session-wide NVIDIA forcing with iGPU-default DRM (the pre-ADR state — defeats per-app choice, forces the NVIDIA stack on every app).

Exception, accepted 2026-08-19 (ticket #183): the Steam gamescope session carries the offload triple session-wide (`__NV_PRIME_RENDER_OFFLOAD=1`, `__GLX_VENDOR_LIBRARY_NAME=nvidia`, `__VK_LAYER_NV_optimus=NVIDIA_only`). This is not a re-adoption of session-wide forcing: the gamescope session is an opt-in gaming session — the user picks it deliberately, and every app inside it is a game. The desktop session stays iGPU-default with per-app opt-in.

Status: accepted
