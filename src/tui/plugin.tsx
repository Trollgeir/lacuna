/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { formatTokens } from "../core/format.ts"
import { jobDetails, jobLabel, jobWarns } from "./job-status.ts"
import { archiveSpinner, SPINNER_INTERVAL } from "./spinner.ts"
import type { ArchiveJobStatus } from "../core/archive/status.ts"
import { Lacuna, type Stats } from "../rpc.ts"
import { connectStatusFeed } from "./state.ts"

export default Plugin.define({
  id: "lacuna.tui",
  setup(context) {
    const rpc = context.client.rpc(Lacuna)
    const [stats, setStats] = createSignal<Record<string, Stats>>({})
    const { feed, dispose } = connectStatusFeed(
      rpc,
      (sessionID) => context.data.session.get(sessionID)?.location ?? context.location ?? context.data.location.default(),
      (value) => void setStats((all) => ({ ...all, [value.sessionID]: value })),
    )

    const theme = () => context.theme

    const Job = (props: { job: ArchiveJobStatus }) => {
      const [now, setNow] = createSignal(Date.now())
      createEffect(() => {
        if (props.job.status !== "running") return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        onCleanup(() => clearInterval(timer))
      })
      const color = () => jobWarns(props.job) ? theme().text.feedback.warning.base : theme().text.feedback.info.base
      return <text fg={color()}>{jobLabel(props.job, now())}</text>
    }

    const Footer = (props: { sessionID?: string }) => {
      const [now, setNow] = createSignal(Date.now())
      createEffect(() => {
        if (props.sessionID) void feed.fetch(props.sessionID)
      })
      const current = () => (props.sessionID ? stats()[props.sessionID] : undefined)
      createEffect(() => {
        if (current()?.job?.status !== "running") return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), SPINNER_INTERVAL)
        onCleanup(() => clearInterval(timer))
      })
      const spinner = () => archiveSpinner(current()?.job, now())
      return (
        <Show when={current()}>
          {(value) => {
            const saved = () => value().archived
            return (
              <box flexDirection="row" gap={1}>
                <Show when={spinner()}>
                  {(frame) => <text fg={theme().text.feedback.info.base}>{frame()}</text>}
                </Show>
                <text fg={theme().text.faint}>archived</text>
                <text fg={saved() > 0 ? theme().text.feedback.info.base : theme().text.faint}>
                  {`~${formatTokens(saved())}`}
                </text>
                <Show when={value().changed}>
                  <text fg={theme().text.feedback.info.base}>*</text>
                </Show>
              </box>
            )
          }}
        </Show>
      )
    }

    const slot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => <Footer sessionID={input.sessionID} />,
    })

    const composer = context.ui.slot({
      append: "session.composer.top",
      render: (input) => {
        createEffect(() => {
          if (input.sessionID) void feed.fetch(input.sessionID)
        })
        const job = () => input.sessionID ? stats()[input.sessionID]?.job : undefined
        return (
          <Show when={job()?.status === "running" && job()}>
            {(value) => (
              <box flexDirection="row" gap={1}>
                <Job job={value()} />
                <text fg={theme().text.faint}>/lacuna for details</text>
              </box>
            )}
          </Show>
        )
      },
    })

    context.keymap.layer(() => ({
      // Keep discovery and invocation reachable outside the default input scope.
      mode: "global",
      commands: [{
        id: "lacuna.job",
        title: "Show archive job",
        group: "Lacuna",
        palette: true,
        slash: { name: "lacuna" },
        enabled: () => context.ui.router.current().type === "session",
        run: async () => {
          const route = context.ui.router.current()
          if (route.type !== "session") return
          await feed.fetch(route.sessionID)
          const job = feed.get(route.sessionID)?.job
          await context.ui.dialog.alert({
            title: "Lacuna archive jobs",
            message: job ? jobDetails(job, Date.now()) : "No background archive job in this session.",
          })
        },
      }],
    }))

    return () => {
      dispose()
      slot()
      composer()
    }
  },
})
