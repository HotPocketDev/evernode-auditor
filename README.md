# Evernode Auditor

## What's here?
*In development*

A node js version of evernode auditor

## Setting up auditor development environment
1. `npm install` (You only have to do this once)
1. Create auditor.cfg `{"xrpl":{"address":"","secret":"","hookAddress":""}}`
1. Update xrpl account details.
1. `node auditor` (auditor.cfg need to be provided with xrpl account data)
1. To change rippled server run `RIPPLED_URL=<server url> node auditor.js`

## Installing auditor in prod environment
1. `cd installer && sudo ./auditor-install.sh` (You only have to do this once)
1. Update xrpl account details in `/etc/evernode-auditor/auditor.cfg`

## Generating setup package
1. `npm run build:installer` will create `dist/auditor-installer.tar.gz`