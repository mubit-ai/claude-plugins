# Third-party notices

`mcp/dist/server.js` is a single-file esbuild bundle of the MCP server this plugin ships
(built from `@mubit-ai/mcp`, which pulls in the packages below). The build pins
`legalComments: 'none'` — `esbuild.config.mjs`, the `shared` block — so the copyright and
license comments that normally ride along inside each source file are absent from the
artifact. MIT and Apache-2.0 both condition redistribution on those notices accompanying
the work, so this file is where they ride instead.

Most of the bundle is our own code (`@mubit-ai/mcp`, `@mubit-ai/sdk`), covered by
[LICENSE](LICENSE). Everything else in it:

| Component | License | Copyright / attribution | Upstream |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk` | MIT / Apache-2.0 (mixed — see note 1) | Copyright (c) 2024–2025 Model Context Protocol, a Series of LF Projects, LLC | <https://github.com/modelcontextprotocol/typescript-sdk> |
| `zod` | MIT | Copyright (c) Colin McDonnell | <https://github.com/colinhacks/zod> |
| `@grpc/grpc-js` | Apache-2.0 | Copyright 2019 gRPC authors (Google Inc.) | <https://github.com/grpc/grpc-node> |
| `@grpc/proto-loader` | Apache-2.0 | Copyright 2019 gRPC authors (Google Inc.) | <https://github.com/grpc/grpc-node> |
| `protobufjs` | BSD-3-Clause | Copyright (c) 2016, Daniel Wirtz | <https://github.com/protobufjs/protobuf.js> |
| `long` | Apache-2.0 | Copyright 2016 Daniel Wirtz | <https://github.com/dcodeIO/long.js> |
| `lodash.camelcase` | MIT | Copyright John-David Dalton (Lodash) | <https://github.com/lodash/lodash> |

Versions are resolved at build time by the source repository's `mcp/package-lock.json`
(this published tree does not carry the lockfile); `@grpc/grpc-js` also embeds its version
string in the bundle, so `grep 'grpc-node-js/' mcp/dist/server.js` reads back what shipped.

1. The TypeScript SDK's upstream `LICENSE` is transitional: code contributed before the
   relicense remains MIT, later contributions are Apache-2.0, and non-spec documentation
   is CC-BY-4.0 (documentation is not bundled here). Either way the grant covers bundled
   use; the table's attribution line is the one their LICENSE carries.
2. No component in this bundle imposes copyleft: MIT, BSD-3-Clause, and Apache-2.0 are
   all permissive, and each grants what our own Apache-2.0 LICENSE requires us to pass
   through — which is exactly what this file does.

## License texts

### MIT — `@modelcontextprotocol/sdk`, `zod`, `lodash.camelcase`

Permission is hereby granted, free of charge, to any person obtaining a copy of this
software and associated documentation files (the "Software"), to deal in the Software
without restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.

### BSD-3-Clause — `protobufjs`

Copyright (c) 2016, Daniel Wirtz. All rights reserved.

Redistribution and use in source and binary forms, with or without modification, are
permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of
   conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice, this list of
   conditions and the following disclaimer in the documentation and/or other materials
   provided with the distribution.
3. Neither the name of the copyright holder nor the names of its contributors may be used
   to endorse or promote products derived from this software without specific prior
   written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY
EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL
THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT
OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR
TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Apache-2.0 — `@grpc/grpc-js`, `@grpc/proto-loader`, `long`

The full Apache License, Version 2.0 text is [LICENSE](LICENSE) in this directory; the
copyright lines particular to these components are in the table above.
