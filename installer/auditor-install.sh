#!/bin/bash
# Auditor installation script.
# This must be executed with root privileges.

auditor_bin=/usr/bin/evernode-auditor
auditor_data=/etc/evernode-auditor
auditor_conf="$auditor_data"/auditor.cfg
auditor_contract="$auditor_data"/auditor-contract
auditor_client="$auditor_data"/auditor-client
auditor_service="evernode-auditor"
hook_xrpl_addr="rb4H5w7H1QA2qKjHCRSuUey2fnMBGbN2c"
script_dir=$(dirname "$(realpath "$0")")

xrpl_server_url="wss://hooks-testnet.xrpl-labs.com"

[ -d $auditor_bin ] && [ -n "$(ls -A $auditor_bin)" ] &&
    echo "Aborting installation. Previous Auditor installation detected at $auditor_bin" && exit 1

# jq command is used for json manipulation.
if ! command -v jq &>/dev/null; then
    echo "jq utility not found. Installing.."
    apt-get install -y jq >/dev/null 2>&1
fi

# Create bin dirs first so it automatically checks for privileged access.
# Copying the binaries
( ! cp -r "$script_dir"/auditor $auditor_bin ) && echo "Could not create '$auditor_bin'. Make sure you are running as sudo." && exit 1
( ! mkdir -p $auditor_data ) && echo "Could not create '$auditor_data'. Make sure you are running as sudo." && exit 1

function rollback() {
    echo "Rolling back auditor installation."
    "$script_dir"/auditor-uninstall.sh -q # Quiet uninstall.
    echo "Rolled back the installation."
    exit 1
}

echo "Installing Auditor..."

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

#Setting up the audit contract.
echo "Setting up the audit contract..."
( ! mkdir -p $auditor_contract ) && echo "Could not create '$auditor_contract'. Make sure you are running as sudo." && rollback
( ! mkdir -p $auditor_client ) && echo "Could not create '$auditor_client'. Make sure you are running as sudo." && rollback

echo "Do you want to setup a custom audit contract?"
read -p "Type 'yes' to upload custom audit contract: " confirmation </dev/tty
if [ "$confirmation" == "yes" ]; then
    # Upload custom contract code goes here.
    echo "Setting up the custom audit contract..."
else
    echo "Setting up the default audit contract..."
    ( ! cp -r "$script_dir"/default-contract/* $auditor_contract ) && echo "Error copying the default contract." && rollback
    ( ! cp -r "$script_dir"/default-client/* $auditor_client ) && echo "Error copying the default client." && rollback
    ( ! cp -r "$script_dir"/contract-template.config $auditor_data ) && echo "Error copying the contract config template." && rollback
fi

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
    WorkingDirectory=$auditor_bin
    Environment=\"DATA_DIR=$auditor_data\"
    ExecStart=/bin/bash -c 'node $auditor_bin'
    Restart=on-failure
    RestartSec=5
    [Install]
    WantedBy=multi-user.target" >/etc/systemd/system/$auditor_service.service

# This service needed to be restarted when auditor.cfg is changed.
systemctl enable $auditor_service
systemctl start $auditor_service

echo "Auditor installed successfully."
exit 0
