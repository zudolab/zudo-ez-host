#!/usr/bin/env node

import { runRemoteSmoke } from "./remote-smoke.mjs";

process.exitCode = await runRemoteSmoke();
