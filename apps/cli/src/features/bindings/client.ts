import { emit } from "../../cli/output.js";
import { EXIT, reportRefusal } from "../../cli/exit.js";
import { channelIdentity, printable, TaviError } from "@tavi/contracts";
import { channelDescriptorOf, recordedConnectionProviders, registerBuiltinChannelsOf } from "../channels/catalog.js";
import { nowTimestamp } from "@tavi/contracts/util";
import type { BindingsCommandOptions } from "./parse.js";
import { requireFlag } from "../../cli/flags.js";
import type { CliIo } from "../../cli/io.js";
import { type ResolvedDataDirectory, withStore } from "../../cli/store.js";

/** A text column of a listing: printable, and on its own line. */
const cell = (text: string): string => printable(text).replace(/\n/g, " ");

export async function bindingsCommand(options: ResolvedDataDirectory<BindingsCommandOptions>, io: CliIo): Promise<number> {
  try {
    return await withStore(options.dataDirectory, async (store) => {
      // The channels an owner would install: the built-in ones whose plugins are enabled.
      await registerBuiltinChannelsOf(store.asPort().repositories);
      const bindings = store.asPort().repositories.messagingIdentityBindings;

      switch (options.action) {
        case "bind": {
          const connectionId = requireFlag(options.connectionId, "--connection");
          // In the sender form of the connection's channel: an
          // email address case-folded, as inbound mail's sender is. A
          // connection this data directory has no record of keeps the old rule.
          const sender = requireFlag(options.externalSenderId, "--sender");
          const descriptor = channelDescriptorOf((await recordedConnectionProviders(store.asPort().repositories)).get(connectionId));
          let externalSenderId: string | undefined;
          if (descriptor !== undefined) externalSenderId = channelIdentity(sender, descriptor.sender);
          else externalSenderId = sender.includes("@") ? sender.toLowerCase() : sender;
          if (externalSenderId === undefined) {
            throw new TaviError(
              "INVALID_INPUT",
              `${sender} is not a ${descriptor?.sender.label.toLowerCase() ?? "sender id"} on ${descriptor?.label ?? connectionId}${descriptor === undefined ? "" : `, such as ${descriptor.sender.placeholder}`}`,
            );
          }
          await bindings.bind({
            connectionId,
            externalSenderId,
            workspaceId: options.workspaceId,
            principalId: requireFlag(options.principalId, "--principal"),
            approvedBy: options.approvedBy,
            createdAt: nowTimestamp(),
            ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
          });
          if (options.trustUnverified !== undefined) {
            await bindings.setTrustUnverified(
              connectionId,
              externalSenderId,
              options.trustUnverified ? { setBy: options.approvedBy, setAt: nowTimestamp() } : null,
            );
          }
          const created = await bindings.get(connectionId, externalSenderId);
          if (created === undefined) {
            throw new TaviError("INTERNAL", "bind() succeeded but the binding could not be re-read");
          }
          emit(
            io,
            options.format,
            created,
            (row) =>
              `bound ${cell(row.externalSenderId)} on ${row.connectionId} to ${row.principalId}${row.displayName === undefined ? "" : ` (${cell(row.displayName)})`}${row.trustUnverified === undefined ? "" : ", trusting their unverified messages"}`,
          );
          return EXIT.ok;
        }
        case "unbind": {
          const connectionId = requireFlag(options.connectionId, "--connection");
          const externalSenderId = requireFlag(options.externalSenderId, "--sender");
          // The address as given, and folded as `bind` stores it: either way the person is unbound.
          await bindings.unbind(connectionId, externalSenderId);
          if (externalSenderId.includes("@")) await bindings.unbind(connectionId, externalSenderId.toLowerCase());
          emit(io, options.format, { unbound: true, connectionId, externalSenderId }, () => "unbound");
          return EXIT.ok;
        }
        case "list": {
          const rows = await bindings.list(options.workspaceId);
          emit(io, options.format, rows, (values) =>
            values.length === 0
              ? "(no bindings)"
              : values
                  .map(
                    // The sender and its name are a stranger's words: printed with no escape or control in them.
                    (row) =>
                      `${row.connectionId}\t${cell(row.externalSenderId)}\t${row.principalId}\t${row.approvedBy}\t${row.displayName === undefined ? "-" : cell(row.displayName)}${row.trustUnverified === undefined ? "" : "\ttrusts-unverified"}`,
                  )
                  .join("\n"),
          );
          return EXIT.ok;
        }
        default:
          io.stderr("Unsupported bindings action\n");
          return EXIT.usage;
      }
    });
  } catch (error) {
    // A rebind refused because the pair is already bound to a different
    // principal (CONFLICT) is a usage error (unbind first), not an internal failure.
    return reportRefusal(error, io, "bindings command failed", { usage: ["INVALID_INPUT"] });
  }
}
