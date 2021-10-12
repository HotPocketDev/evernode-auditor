#!/bin/bash

path=$(realpath ./)
pushd $path

if [ "$1" != "installer" ]; then
    npm install
    ncc build auditor.js -o dist/auditor

    # Build default audit client.
    pushd ./dependencies/default-client >/dev/null 2>&1
    ncc build default-client.js -o dist/default-client
    popd >/dev/null 2>&1
    # Build default audit contract.
    pushd ./dependencies/default-contract >/dev/null 2>&1
    ncc build default-contract.js -o dist/default-contract
    popd >/dev/null 2>&1
else
    # Create installer directories.
    mkdir -p ./dist/auditor-installer

    # Copy build files and dependencies.
    cp -r ./dist/auditor ./dist/auditor-installer/
    cp -r ./installer/auditor-install.sh ./dist/auditor-installer/
    cp -r ./installer/auditor-uninstall.sh ./dist/auditor-installer/

    # Copy dependencies to the installer directory.
    cp -r ./dependencies/default-client/dist/default-client ./dist/auditor-installer/
    cp -r ./dependencies/default-contract/dist/default-contract ./dist/auditor-installer/
    cp -r ./dependencies/contract-template.config ./dist/auditor-installer/

    # Create the bundle and remove directory.
    tar cfz ./dist/auditor-installer.tar.gz --directory=./dist auditor-installer
    rm -r ./dist/auditor-installer
fi

popd >/dev/null 2>&1
