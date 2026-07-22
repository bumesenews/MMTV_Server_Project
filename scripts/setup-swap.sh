#!/usr/bin/env bash
# Create a 2GB swapfile on Ubuntu EC2 (t3.micro 1GB RAM).
# Run once as root:  sudo bash scripts/setup-swap.sh
set -euo pipefail

SWAPFILE="${SWAPFILE:-/swapfile}"
SWAP_SIZE="${SWAP_SIZE:-2G}"

if swapon --show | grep -q .; then
  echo "Swap already active:"
  swapon --show
  free -h
  exit 0
fi

if [[ -f "$SWAPFILE" ]]; then
  echo "Found existing $SWAPFILE — enabling"
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
  swapon "$SWAPFILE"
else
  echo "Creating $SWAP_SIZE swap at $SWAPFILE"
  fallocate -l "$SWAP_SIZE" "$SWAPFILE" || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048
  chmod 600 "$SWAPFILE"
  mkswap "$SWAPFILE"
  swapon "$SWAPFILE"
fi

if ! grep -q "$SWAPFILE" /etc/fstab; then
  echo "$SWAPFILE none swap sw 0 0" >> /etc/fstab
fi

# Prefer RAM; use swap only under pressure (default 60 is too aggressive for scrapers)
sysctl vm.swappiness=10
if ! grep -q 'vm.swappiness' /etc/sysctl.conf; then
  echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi

echo "Swap ready:"
swapon --show
free -h
