#!/bin/bash

# Create installer directories.
mkdir -p ./dist/auditor-installer

# Copy build files and dependencies.
cp -r ./dist/auditor ./dist/auditor-installer/
cp -r ./installer/auditor-install.sh ./dist/auditor-installer/
cp -r ./installer/auditor-uninstall.sh ./dist/auditor-installer/

path=$(realpath ./)
# Build default audit client.
pushd $path/dependencies/default-client > /dev/null 2>&1
npm run build
popd > /dev/null 2>&1
# Build default audit contract.
pushd $path/dependencies/default-contract > /dev/null 2>&1
npm run build
popd > /dev/null 2>&1
# Copy build files to the installer directory.
cp -r ./dependencies/default-client/dist/default-client ./dist/auditor-installer/
cp -r ./dependencies/default-contract/dist/default-contract ./dist/auditor-installer/
cp -r ./dependencies/contract-template.config ./dist/auditor-installer/

# Create the bundle and remove directory.
tar cfz ./dist/auditor-installer.tar.gz --directory=./dist auditor-installer
rm -r ./dist/auditor-installer