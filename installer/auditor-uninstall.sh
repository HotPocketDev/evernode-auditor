#!/bin/bash
# Auditor installation script.
# This must be executed with root privileges.
# -q for non-interactive (quiet) mode

auditor_bin=/usr/bin/evernode-auditor
auditor_data=/etc/evernode-auditor
auditor_service="evernode-auditor"
quiet=$1

[ ! -d $auditor_bin ] && echo "$auditor_bin does not exist. Aborting uninstall." && exit 1

if [ "$quiet" != "-q" ]; then
    echo "Are you sure you want to uninstall Auditor?"
    read -p "Type 'yes' to confirm uninstall: " confirmation < /dev/tty
    [ "$confirmation" != "yes" ] && echo "Uninstall cancelled." && exit 0
fi

echo "Removing auditor service..."
systemctl stop $auditor_service
systemctl disable $auditor_service
rm /etc/systemd/system/$auditor_service.service

echo "Deleting binaries..."
rm -r $auditor_bin

echo "Deleting data folder..."
rm -r $auditor_data

echo "Auditor uninstalled successfully."
exit 0
