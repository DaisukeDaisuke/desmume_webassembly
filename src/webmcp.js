import { ErrorCode } from "./error-codes.js";

export function registerWebMcp({ commands, descriptions, responder, runCommand, compact, installShortcuts, logger }) {
    const toContent = (result) => responder.toWebMcpContent(result, compact);
    const parseInput = (input) => {
        try {
            if (typeof input !== "string") return responder.ok({ value: input || {} });
            if (!input.trim()) return responder.ok({ value: {} });
            return responder.ok({ value: JSON.parse(input) });
        } catch (error) {
            return responder.fail(ErrorCode.INVALID_ARGUMENT, "WebMCP input is not valid JSON", {
                message: String(error?.message || error)
            });
        }
    };
    const executeParsed = async (input, handler) => {
        const parsed = parseInput(input);
        if (!parsed.ok) return toContent(parsed);
        return toContent(await handler(parsed.value));
    };

    installShortcuts(runCommand);
    window.DesmumeMCP = {
        call: runCommand,
        list: () => Object.fromEntries(Object.keys(commands).map((name) => [name, descriptions[name] || ""])),
        shortcuts: () => window.DesmumeShortcuts || {}
    };
    window.memory = {
        getregister: (register, cpu) => runCommand("memoryGetRegister", { register, cpu }),
        setregister: (register, value, cpu) => runCommand("memorySetRegister", { register, value, cpu }),
        readbyte: (address, cpu) => runCommand("memoryReadByte", { address, cpu }),
        readword: (address, cpu) => runCommand("memoryReadWord", { address, cpu }),
        readdword: (address, cpu) => runCommand("memoryReadDword", { address, cpu }),
        writebyte: (address, value, cpu) => runCommand("memoryWriteByte", { address, value, cpu }),
        writeword: (address, value, cpu) => runCommand("memoryWriteWord", { address, value, cpu }),
        writedword: (address, value, cpu) => runCommand("memoryWriteDword", { address, value, cpu })
    };
    window.memory.reg = window.memory.getregister;
    window.memory.regw = window.memory.setregister;
    window.memory.read8 = window.memory.readbyte;
    window.memory.read16 = window.memory.readword;
    window.memory.read32 = window.memory.readdword;
    window.memory.write8 = window.memory.writebyte;
    window.memory.write16 = window.memory.writeword;
    window.memory.write32 = window.memory.writedword;

    async function registerBrowserTools() {
        const modelContext = ("modelContext" in navigator && navigator.modelContext)
            || ("modelContext" in document && document.modelContext);
        if (!modelContext || typeof modelContext.registerTool !== "function") return false;
        const registrations = [{
            name: "desmume.list",
            title: "DeSmuME command list",
            description: "Lists available DeSmuME Web Debugger commands and their short descriptions.",
            inputSchema: { type: "object", additionalProperties: false },
            annotations: { readOnlyHint: true },
            execute: async () => toContent(window.DesmumeMCP.list())
        }, {
            name: "desmume.call",
            title: "DeSmuME command",
            description: "Runs one DeSmuME Web Debugger command by name.",
            inputSchema: {
                type: "object",
                required: ["command"],
                properties: {
                    command: { type: "string" },
                    params: { type: "object", additionalProperties: true }
                },
                additionalProperties: false
            },
            execute: (input = {}) => executeParsed(input, (parsed) => runCommand(
                String(parsed.command || ""),
                parsed.params || {}
            ))
        }, {
            name: "desmume.eval",
            title: "DeSmuME eval",
            description: "Runs isolated JavaScript with mcp.call(command, params).",
            inputSchema: {
                type: "object",
                required: ["code"],
                properties: {
                    code: { type: "string" },
                    timeoutMs: { type: "number" }
                },
                additionalProperties: false
            },
            execute: (input = {}) => executeParsed(input, (parsed) => commands.eval(parsed))
        }, {
            name: "desmume.runScript",
            title: "DeSmuME run script",
            description: "Alias for desmume.eval for clients that avoid eval-named tools.",
            inputSchema: {
                type: "object",
                required: ["code"],
                properties: {
                    code: { type: "string" },
                    timeoutMs: { type: "number" }
                },
                additionalProperties: false
            },
            execute: (input = {}) => executeParsed(input, (parsed) => commands.runScript(parsed))
        }];
        let registered = 0;
        for (const tool of registrations) {
            try {
                await modelContext.registerTool(tool);
                registered++;
            } catch (error) {
                if (String(error?.message || error).includes("already")) registered++;
                else console.warn("WebMCP register failed", tool.name, error);
            }
        }
        logger(`WebMCP registered ${registered} tools`);
        return registered > 0;
    }

    window.addEventListener("message", async (event) => {
        const message = event.data || {};
        if (message.type !== "desmume-mcp") return;
        const result = await runCommand(message.command, message.params || {});
        event.source?.postMessage(
            { type: "desmume-mcp-result", id: message.id, result },
            event.origin || "*"
        );
    });
    void registerBrowserTools().catch((error) => logger(error?.message || String(error)));
    return { registerBrowserTools };
}
