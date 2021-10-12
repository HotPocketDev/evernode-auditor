#!/bin/bash

path=$(realpath ./)
pushd $path

if [ "$1" != "installer" ]; then
    npm install
    ncc build auditor.js -o dist/auditor

    # Build default audit client and contract
    ncc build ./dependencies/default-client/default-client.js -o dist/default-client
    ncc build ./dependencies/default-contract/default-contract.js -o dist/default-contract
    cp ./dependencies/default-contract/contract.config dist/default-contract
else
    # Create installer directories.
    mkdir -p ./dist/auditor-installer

    # Copy build files and dependencies.
    cp -r ./dist/auditor ./dist/auditor-installer/
    cp -r ./dist/default-client ./dist/auditor-installer/
    cp -r ./dist/default-contract ./dist/auditor-installer/
    cp -r ./installer/auditor-install.sh ./dist/auditor-installer/
    cp -r ./installer/auditor-uninstall.sh ./dist/auditor-installer/

    # Create the bundle and remove directory.
    tar cfz ./dist/auditor-installer.tar.gz --directory=./dist auditor-installer
    rm -r ./dist/auditor-installer
fi

popd >/dev/null 2>&1
