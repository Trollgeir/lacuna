/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import { formatTokens } from "./core/render.ts"
import { Lacuna, type Stats } from "./rpc.ts"

export default Plugin.define({
  id: "lacuna.tui",
  setup(context) {
    const rpc = context.client.rpc(Lacuna)
    const [stats, setStats] = createSignal<Record<string, Stats>>({})
    const store = (value: Stats) => void setStats((all) => ({ ...all, [value.sessionID]: value }))

    const stop = rpc.events.on("stats", (event) => store(event.data as unknown as Stats))

    const requested = new Set<string>()
    const fetchOnce = (sessionID: string) => {
      if (requested.has(sessionID)) return
      requested.add(sessionID)
      rpc
        .stats({ sessionID })
        .then((output) => {
          const value = (output as { stats?: Stats }).stats
          if (value) store(value)
        })
        .catch(() => requested.delete(sessionID))
    }

    const theme = () => context.theme

    const Footer = (props: { sessionID?: string }) => {
      createEffect(() => {
        if (props.sessionID) fetchOnce(props.sessionID)
      })
      const current = () => (props.sessionID ? stats()[props.sessionID] : undefined)
      return (
        <Show when={current()}>
          {(value) => {
            const saved = () => value().archived
            return (
              <box flexDirection="row" gap={1}>
                <text fg={theme().text.faint}>archived</text>
                <text fg={saved() > 0 ? theme().text.feedback.info.base : theme().text.faint}>
                  {`~${formatTokens(saved())}`}
                </text>
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

    return () => {
      stop()
      slot()
    }
  },
})
