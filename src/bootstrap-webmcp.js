export function createBootstrapWebMcpTools({
    bootstrapApi,
    webMcpContent,
    parseInput,
    fail
}) {
    const execute = (handler) => async (input = {}) => {
        try {
            return webMcpContent(await handler(parseInput(input)));
        } catch (error) {
            return webMcpContent(fail("INVALID_ARGUMENT", "WebMCP input is not valid JSON", {
                message: String(error?.message || error).slice(0, 500)
            }));
        }
    };
    return [{
        name: "desmume.list",
        title: "DeSmuME command list",
        description: "Lists the runtime-free command surface. Loading a ROM loads the emulator runtime.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: execute(() => bootstrapApi.list())
    }, {
        name: "desmume.call",
        title: "DeSmuME command",
        description: "Runs one local command. Only ROM load commands load the emulator runtime.",
        inputSchema: {
            type: "object",
            required: ["command"],
            properties: {
                command: { type: "string" },
                params: { type: "object", additionalProperties: true }
            },
            additionalProperties: false
        },
        execute: execute((input) => bootstrapApi.call(
            String(input.command || ""),
            input.params || {}
        ))
    }, {
        name: "desmume.eval",
        title: "DeSmuME eval",
        description: "Runs isolated JavaScript after the emulator runtime is available.",
        inputSchema: {
            type: "object",
            required: ["code"],
            properties: { code: { type: "string" }, timeoutMs: { type: "number" } },
            additionalProperties: false
        },
        execute: execute((input) => bootstrapApi.call("eval", input))
    }, {
        name: "desmume.runScript",
        title: "DeSmuME run script",
        description: "Alias for desmume.eval with the same isolated Worker boundary.",
        inputSchema: {
            type: "object",
            required: ["code"],
            properties: { code: { type: "string" }, timeoutMs: { type: "number" } },
            additionalProperties: false
        },
        execute: execute((input) => bootstrapApi.call("runScript", input))
    }];
}
