#!/usr/bin/env bash

node --test tests/new-plan-services.test.mjs tests/boundary-regressions.test.mjs \
    > .test-fix-20260802c.log 2>&1
printf '%s\n' "$?" > .test-fix-20260802c.exit
