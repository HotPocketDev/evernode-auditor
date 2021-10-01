# Evernode Auditor

## What's here?
*In development*

A node js version of evernode auditor

## Setting up auditor development environment
1. `npm install` (You only have to do this once)
1. Create auditor.cfg `{"xrpl":{"address":"","secret":"","hookAddress":"$hook_xrpl_addr"}}`
1. Update xrpl account details.
1. `node auditor wss://hooks-testnet.xrpl-labs.com --dev` (audit.cfg need to be provided with ixrpl account data)
1. Frist Command line param is ripple server url which is required.
1. Optional command line param `--dev` for dev mode, if not given it'll be prod mode.
1. Optional Command line param `--enable-logging` will keeps logging in a log file inside log directory.

## Installing auditor in prod environment
1. `cd installer && sudo ./auditor-install.sh` (You only have to do this once)
1. Update xrpl account details in `/etc/evernode-auditor/auditor.cfg`

## Generating setup package
1. `npm run build:installer` will create `dist/auditor-installer.tar.gz`