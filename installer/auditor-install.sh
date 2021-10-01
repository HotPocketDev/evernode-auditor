#!/bin/bash
# Auditor installation script.
# This must be executed with root privileges.

auditor_bin=/usr/bin/evernode-auditor
auditor_data=/etc/evernode-auditor
auditor_conf="$auditor_data"/auditor.cfg
auditor_service="evernode-auditor"
hook_xrpl_addr="rb4H5w7H1QA2qKjHCRSuUey2fnMBGbN2c"
script_dir=$(dirname "$(realpath "$0")")

xrpl_server_url="wss://hooks-testnet.xrpl-labs.com"

[ -d $auditor_bin ] && [ -n "$(ls -A $auditor_bin)" ] &&
    echo "Aborting installation. Previous Auditor installation detected at $auditor_bin" && exit 1

# Create bin dirs first so it automatically checks for privileged access.
# Copying the binaries
cp -r "$script_dir"/auditor $auditor_bin
[ "$?" == "1" ] && echo "Could not create '$auditor_bin'. Make sure you are running as sudo." && exit 1
mkdir -p $auditor_data
[ "$?" == "1" ] && echo "Could not create '$auditor_data'. Make sure you are running as sudo." && exit 1

echo "Installing Auditor..."

function rollback() {
    echo "Rolling back auditor installation."
    "$script_dir"/auditor-uninstall.sh -q # Quiet uninstall.
    echo "Rolled back the installation."
    exit 1
}

echo "Please answer following questions to setup auditor.."
# Ask for input until a correct value is given
while [ -z "$address" ] || [[ ! "$address" =~ ^[A-Za-z0-9]{34}$ ]]; do
    read -p "Xrpl address? " address </dev/tty
    ([ -z "$address" ] && echo "Xrpl address cannot be empty.") || ([[ ! "$address" =~ ^[A-Za-z0-9]{34}$ ]] && echo "Invalid xrpl address.")
done
while [ -z "$secret" ] || [[ ! "$secret" =~ ^[A-Za-z0-9]{29}$ ]]; do
    read -p "Xrpl Secret? " secret </dev/tty
    ([ -z "$secret" ] && echo "Xrpl secret cannot be empty.") || ([[ ! "$secret" =~ ^[A-Za-z0-9]{29}$ ]] && echo "Invalid xrpl secret.")
done

(! echo "{\"xrpl\":{\"address\":\"$address\",\"secret\":\"$secret\",\"hookAddress\":\"$hook_xrpl_addr\"}}" | jq . >$auditor_conf) && rollback

# Install auditor systemd service.
# StartLimitIntervalSec=0 to make unlimited retries. RestartSec=5 is to keep 5 second gap between restarts.
echo "[Unit]
    Description=Running and monitoring evernode auditoring.
    After=network.target
    StartLimitIntervalSec=0
    [Service]
    User=root
    Group=root
    Type=simple
    WorkingDirectory=$auditor_data
    ExecStart=/bin/bash -c 'node $auditor_bin $xrpl_server_url --enable-logging'
    Restart=on-failure
    RestartSec=5
    [Install]
    WantedBy=multi-user.target" >/etc/systemd/system/$auditor_service.service

# This service needed to be restarted when auditor.cfg is changed.
systemctl enable $auditor_service
systemctl start $auditor_service

echo "Auditor installed successfully."
exit 0
