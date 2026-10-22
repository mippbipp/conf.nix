import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node";
import {
  Action,
  ActionPanel,
  Icon,
  List,
  Toast,
  closeMainWindow,
  getApplications,
  showToast,
} from "@vicinae/api";
import type { Application } from "@vicinae/api";
import { Effect, Layer, ManagedRuntime } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { useEffect, useState } from "react";
import { DgpuConfig } from "./config.js";
import { Dgpu } from "./dgpu.js";
import { DgpuError } from "./errors.js";

const NodeDgpu = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer)),
);

const DgpuLive = Dgpu.layer.pipe(
  Layer.provide(DgpuConfig.layer),
  Layer.provideMerge(NodeDgpu),
);

const runtime = ManagedRuntime.make(DgpuLive);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

function isSourceApp(app: Application): boolean {
  return app.id.endsWith(".desktop") && !app.id.endsWith(" (dGPU).desktop");
}

export default function DgpuApps() {
  const [apps, setApps] = useState<Array<Application>>([]);
  const [assigned, setAssigned] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);

    try {
      const [result, installed] = await Promise.all([
        runtime.runPromise(
          Effect.gen(function* () {
            const dgpu = yield* Dgpu;
            const reconcileError = yield* dgpu.reconcile().pipe(
              Effect.match({
                onFailure: (cause) => cause.message,
                onSuccess: () => null,
              }),
            );
            const enabled = yield* dgpu.assigned();
            return { enabled, reconcileError };
          }),
        ),
        getApplications(),
      ]);

      const seen = new Set<string>();
      const sources = installed
        .filter(isSourceApp)
        .filter((app) => {
          if (seen.has(app.id)) return false;
          seen.add(app.id);
          return true;
        })
        .sort((a, b) => a.name.localeCompare(b.name));

      setApps(sources);
      setAssigned(result.enabled);
      setError(result.reconcileError);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function toggle(app: Application, enabled: boolean) {
    try {
      const next = await runtime.runPromise(
        Effect.gen(function* () {
          const dgpu = yield* Dgpu;
          yield* dgpu.set(app.id, enabled);
          return yield* dgpu.assigned();
        }),
      );
      setAssigned(next);
      await showToast({
        style: Toast.Style.Success,
        title: enabled
          ? `${app.name} now launches on the dGPU`
          : `${app.name} back on the iGPU`,
      });
    } catch (cause) {
      await showToast({
        style: Toast.Style.Failure,
        title: "dGPU toggle failed",
        message: errorMessage(cause),
      });
    }
  }

  async function launch(app: Application) {
    try {
      await runtime.runPromise(
        Effect.gen(function* () {
          const dgpu = yield* Dgpu;
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const exitCode = yield* spawner.exitCode(
            ChildProcess.make("gio", ["launch", dgpu.wrapperPath(app.id)]),
          );
          if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
            return yield* new DgpuError({
              message: `gio launch exited with code ${exitCode}`,
            });
          }
        }),
      );
      await closeMainWindow();
    } catch (cause) {
      await showToast({
        style: Toast.Style.Failure,
        title: `Could not launch ${app.name}`,
        message: errorMessage(cause),
      });
    }
  }

  const enabledCount = apps.filter((app) => assigned.has(app.id)).length;

  return (
    <List
      isLoading={loading}
      searchBarPlaceholder="Search applications..."
      navigationTitle="dGPU Apps"
    >
      <List.Section title="Applications" subtitle={`${enabledCount} on dGPU`}>
        {apps.map((app) => {
          const enabled = assigned.has(app.id);
          return (
            <List.Item
              key={app.id}
              title={app.name}
              subtitle={
                enabled
                  ? "Launches with PRIME render offload"
                  : "Launches normally"
              }
              icon={app.icon ? { source: app.icon } : Icon.AppWindow}
              accessories={
                enabled
                  ? [{ icon: Icon.CheckCircle, tooltip: "dGPU enabled" }]
                  : []
              }
              actions={
                <ActionPanel>
                  <Action
                    title={enabled ? "Disable dGPU" : "Enable dGPU"}
                    icon={enabled ? Icon.XMarkCircle : Icon.CheckCircle}
                    onAction={() => toggle(app, !enabled)}
                  />
                  {enabled && (
                    <Action
                      title="Launch on dGPU"
                      icon={Icon.Bolt}
                      onAction={() => launch(app)}
                    />
                  )}
                  <Action.CopyToClipboard
                    title="Copy desktop entry ID"
                    content={app.id}
                  />
                </ActionPanel>
              }
            />
          );
        })}
      </List.Section>
      <List.EmptyView
        title={error ? "Could not load dGPU apps" : "No applications found"}
        description={
          error ?? "No desktop entries with an application ID were found."
        }
        icon={error ? Icon.XMarkCircle : Icon.AppWindow}
      />
    </List>
  );
}
