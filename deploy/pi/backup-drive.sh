#!/usr/bin/env bash
# Connect the network drive that holds the backups, at /mnt/golf-backup.
#
#     ./deploy/pi/backup-drive.sh //192.168.1.50/Backups
#
# The address is the drive's Windows/SMB share: //HOST/SHARE (a NAS, a drive
# plugged into the router, or a folder shared from a PC). It asks for the
# share's user name and password, keeps them in a file only root can read, adds
# the drive to /etc/fstab so it comes back after a restart, and writes a test file.
set -euo pipefail

share="${1:-}"
mount=/mnt/golf-backup
credentials=/etc/golf-backup.cred

case "$share" in
  //*/*) ;;
  *) echo "Usage: $0 //HOST/SHARE   (for example //192.168.1.50/Backups)" >&2; exit 1 ;;
esac

read -r -p "User name for $share (leave empty if it needs none): " user
if [ -n "$user" ]; then
  read -r -s -p "Password: " password; echo
  printf 'username=%s\npassword=%s\n' "$user" "$password" | sudo install -m 600 /dev/stdin "$credentials"
  access="credentials=$credentials"
else
  access="guest"
fi

sudo mkdir -p "$mount"
# nofail: the Pi still starts when the drive is off. uid/gid: the backups belong to this user.
line="$share $mount cifs $access,uid=$(id -u),gid=$(id -g),file_mode=0600,dir_mode=0700,nofail,_netdev,x-systemd.mount-timeout=30 0 0"
sudo sed -i "\\# $mount cifs #d" /etc/fstab
echo "$line" | sudo tee -a /etc/fstab > /dev/null
sudo systemctl daemon-reload

mountpoint -q "$mount" && sudo umount "$mount"
if ! sudo mount "$mount"; then
  echo "Could not connect to $share. Check the address, user name and password, then run this again." >&2
  echo "(If the drive only speaks the old SMB 1 protocol, add ',vers=1.0' after 'cifs $access' in /etc/fstab.)" >&2
  exit 1
fi
mkdir -p "$mount/golf"
echo "written by $(hostname) on $(date)" > "$mount/golf/.write-test"
rm "$mount/golf/.write-test"
echo "Connected: backups go to $mount/golf ($(df -h --output=avail "$mount" | tail -1 | tr -d ' ') free)."
echo "Try one now:  sudo systemctl start golf-backup && journalctl -u golf-backup -n 20 --no-pager"
