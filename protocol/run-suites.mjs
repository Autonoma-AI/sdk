#!/usr/bin/env node
/**
 * Boot each migrated SDK's v2 endpoint and run the shared `protocol/suites/*`
 * against it with `test-runner.ts`. Usage:
 *
 *   node protocol/run-suites.mjs            # runs typescript + python + go + rust + ruby + java + php + elixir
 *   node protocol/run-suites.mjs typescript
 *   node protocol/run-suites.mjs python
 *   node protocol/run-suites.mjs go
 *   node protocol/run-suites.mjs rust
 *   node protocol/run-suites.mjs ruby
 *   node protocol/run-suites.mjs java
 *   node protocol/run-suites.mjs php
 *   node protocol/run-suites.mjs elixir
 *
 * Env: PYTHON (python interpreter for the Python server, default `python3`),
 * GO (go toolchain for building the Go server, default `go`),
 * CARGO (cargo toolchain for building the Rust server, default `cargo`),
 * RUBY (ruby interpreter for the Ruby server, default `ruby`),
 * JAVA (java runtime for the Java server, default `java`),
 * MVN (maven for building the Java server, default `mvn`),
 * PHP (php interpreter for the PHP server, default `php`),
 * MIX (mix toolchain for building + booting the Elixir server, default `mix`).
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dirname, '..')

const SHARED = 'protocol-shared'
const SIGNING = 'protocol-signing'

// tsx is a devDependency of the TypeScript workspace; use its local binary so
// this works without a global install.
const tsxBin = resolve(repoRoot, 'sdks/typescript/node_modules/.bin/tsx')

// The Go server file lives under protocol/ (outside the sdks/go module), so it
// is compiled with the sdks/go module as the build context (cwd) and the file
// referenced by absolute path. Pre-building a binary keeps the compile cost out
// of the readiness window.
const goSdkDir = resolve(repoRoot, 'sdks/go')
const goServerFile = resolve(repoRoot, 'protocol/servers/go-server.go')
const goServerBin = resolve(tmpdir(), 'autonoma-go-protocol-server')

// The Rust server is the autonoma-sdk crate's `protocol-server` binary (its
// source lives under protocol/servers/ but is compiled as a crate bin). It is
// built with the `axum` feature and run from the crate's release target dir.
const rustSdkDir = resolve(repoRoot, 'sdks/rust')
const rustServerBin = resolve(rustSdkDir, 'target/release/protocol-server')

// The Ruby server is stdlib-only and needs no build step; it is run directly
// with the Ruby SDK's lib/ on the load path via an absolute -I.
const rubySdkLib = resolve(repoRoot, 'sdks/ruby/lib')

// The Java server is a main class in the conformance-bridge module. `mvn
// package` builds the shaded fat jar (SDK + Jackson + the JDK HttpServer
// server, plus the version.txt resource); it is then run with `java -cp` and
// the explicit ProtocolServer main class. Building keeps the compile cost out
// of the readiness window, mirroring the Go/Rust build+cwd mechanism.
const javaSdkDir = resolve(repoRoot, 'sdks/java')
const javaBridgeJar = resolve(
  javaSdkDir,
  'conformance-bridge/target/autonoma-conformance-bridge.jar',
)

// The Elixir server file lives under protocol/ (outside the mix project), so it
// is booted with `mix run <absolute path>` and the sdks/elixir project as the
// cwd, which puts the compiled Autonoma modules + Jason on the code path. The
// deps.get + compile happens in a build step to keep the compile cost out of
// the readiness window (mirrors the Go/Rust/Java build+cwd mechanism).
const elixirSdkDir = resolve(repoRoot, 'sdks/elixir')
const elixirServerFile = resolve(repoRoot, 'protocol/servers/elixir-server.exs')
const mixBin = process.env.MIX ?? 'mix'

const targets = {
  typescript: {
    port: 4599,
    command: tsxBin,
    args: ['protocol/servers/ts-server.ts'],
  },
  python: {
    port: 4598,
    command: process.env.PYTHON ?? 'python3',
    args: ['protocol/servers/py_server.py'],
  },
  go: {
    port: 4597,
    command: goServerBin,
    args: [],
    build: {
      command: process.env.GO ?? 'go',
      args: ['build', '-o', goServerBin, goServerFile],
      cwd: goSdkDir,
    },
  },
  rust: {
    port: 4596,
    command: rustServerBin,
    args: [],
    build: {
      command: process.env.CARGO ?? 'cargo',
      args: ['build', '--release', '--features', 'axum', '--bin', 'protocol-server'],
      cwd: rustSdkDir,
    },
  },
  ruby: {
    port: 4595,
    command: process.env.RUBY ?? 'ruby',
    args: ['-I', rubySdkLib, 'protocol/servers/ruby-server.rb'],
  },
  java: {
    port: 4594,
    command: process.env.JAVA ?? 'java',
    args: ['-cp', javaBridgeJar, 'ai.autonoma.conformance.ProtocolServer'],
    build: {
      command: process.env.MVN ?? 'mvn',
      args: ['package', '-DskipTests', '-B'],
      cwd: javaSdkDir,
    },
  },
  // The PHP server is stdlib-only and needs no build step; it requires the PHP
  // SDK's src/ directly via a tiny autoloader and reads PORT/secrets from env.
  php: {
    port: 4593,
    command: process.env.PHP ?? 'php',
    args: ['protocol/servers/php-server.php'],
  },
  // The Elixir server is booted with `mix run` from the mix project so the
  // compiled Autonoma modules + Jason are on the code path. deps.get + compile
  // run as a build step to keep the compile cost out of the readiness window.
  elixir: {
    port: 4592,
    command: mixBin,
    args: ['run', '--no-halt', elixirServerFile],
    cwd: elixirSdkDir,
    build: {
      command: 'sh',
      args: ['-c', `${mixBin} deps.get && ${mixBin} compile`],
      cwd: elixirSdkDir,
    },
  },
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForReady(url) {
  const body = JSON.stringify({ action: 'discover' })
  const signature = createHmac('sha256', SHARED).update(body).digest('hex')
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-signature': signature },
        body,
      })
      if (res.status === 200) return true
    } catch {
      // not up yet
    }
    await sleep(200)
  }
  return false
}

async function runTarget(name) {
  const target = targets[name]
  const url = `http://127.0.0.1:${target.port}`
  console.log(`\n### ${name.toUpperCase()} (${url})`)

  // Some targets (Go) compile a binary before the server can boot.
  if (target.build) {
    console.log(`  building ${name} server ...`)
    const built = spawnSync(target.build.command, target.build.args, {
      cwd: target.build.cwd ?? repoRoot,
      stdio: 'inherit',
    })
    if (built.status !== 0) {
      console.error(`  ${name} server build failed`)
      return 1
    }
  }

  const server = spawn(target.command, target.args, {
    cwd: target.cwd ?? repoRoot,
    env: {
      ...process.env,
      AUTONOMA_SHARED_SECRET: SHARED,
      AUTONOMA_SIGNING_SECRET: SIGNING,
      PORT: String(target.port),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  })

  try {
    const ready = await waitForReady(url)
    if (!ready) {
      console.error(`  ${name} server never became ready`)
      return 1
    }
    const exitCode = await new Promise((resolveExit) => {
      const runner = spawn(
        tsxBin,
        ['protocol/test-runner.ts', '--url', url, '--secret', SHARED],
        { cwd: repoRoot, stdio: 'inherit' },
      )
      runner.on('exit', (code) => resolveExit(code ?? 1))
    })
    return exitCode
  } finally {
    server.kill('SIGTERM')
  }
}

async function main() {
  const requested = process.argv.slice(2)
  const names = requested.length > 0 ? requested : ['typescript', 'python', 'go', 'rust', 'ruby', 'java', 'php', 'elixir']

  let failed = 0
  for (const name of names) {
    if (!targets[name]) {
      console.error(`Unknown target: ${name}`)
      failed++
      continue
    }
    const code = await runTarget(name)
    if (code !== 0) failed++
  }

  console.log(`\n${failed === 0 ? 'ALL PROTOCOL SUITES PASSED' : `${failed} target(s) FAILED`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
