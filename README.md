# What

## Problem

I'm currently experience regular outages of my interntet, where the router goes down for a period of 30-90 seconds at a time.
The ISP is currently working on a finding the issue on their end, but they have no telemetry on when this is happening.

## Solution

We're creating a heartbeat daemon (Node.js) that runs in the background of this PC, and regularly makes network pings to external services. When the ping fails during one of my router outages, we start pinging much much more frequently to get a better estimate of how long the outage is taking.

### Caveats

I want to avoid any quota violation issues by pinging once service too many times or getting false-positives from a single target going down, so we should have a suite of target endpoints to rotate through as we deal with this.

# Output

## Request Logs

Record the period pings to external sites.

* Timestamp of when the ping was started
* The target endpiont
* Response success/failure

## Outage Logs

A filter of request logs that are specifically when the router appears to be down.