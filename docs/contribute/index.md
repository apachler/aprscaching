# Contribute

This section is for people who change APRScaching: the code, the tests and this manual. Start with a running
checkout, then read where your change belongs.

1. [Run from source](run-from-source.md): the gateway, the web app and the ingest from a checkout.
2. [Architecture and runtimes](architecture.md): one gateway, two runtimes.
3. [Testing & verification](testing.md): every check and how to run it.
4. Design notes: the [design language](design/design-language.md), [MeshCom integration (design)](design/meshcom.md),
   [logging finds over radio](design/radio-find-logging.md) and [caches on the MeshCom map](design/meshcom-tdeck-map.md).
5. [The AX.25 stack](ax25-stack.md): the connected-mode data-link layer.
6. Shack tools: a tool is a signed `tool.json` and a script that the **Tools** app runs in a sandbox, published in
   a registry, with no change to this repository. The [tools site](https://apachler.github.io/aprscaching-tools/) holds everything for tool authors and
   publishers: [Write your first tool](https://apachler.github.io/aprscaching-tools/write/first-tool/), [the manifest](https://apachler.github.io/aprscaching-tools/write/manifest/),
   [the sandbox API](https://apachler.github.io/aprscaching-tools/write/sandbox-api/), [API versions](https://apachler.github.io/aprscaching-tools/api/), [publish a registry](https://apachler.github.io/aprscaching-tools/publish/) and
   [contribute a tool to the project registry](https://apachler.github.io/aprscaching-tools/project/contribute/). Using tools is under
   [Tools and plugins](../shack/tools.md).
7. [Style guide for the manual](style-guide.md).
8. [Specification registry](specs.md): what is built from which open specification.

Contributions are inbound = outbound: each one is licensed under the licence of the unit it changes
([About](../about.md)). Commits carry a DCO sign-off (`git commit -s`).

## Next

- [Run from source](run-from-source.md): get a checkout running.
- [Architecture and runtimes](architecture.md): where a change belongs.
