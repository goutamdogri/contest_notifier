# systemd user units for Contest Notifier.
#
# Install:
#   mkdir -p ~/.config/systemd/user
#   cp systemd/contest-notifier.{service,timer} ~/.config/systemd/user/
#   systemctl --user daemon-reload
#   systemctl --user enable --now contest-notifier.timer
#
# Run before logging in (optional but recommended on a laptop):
#   sudo loginctl enable-linger "$USER"
#
# Verify:
#   systemctl --user list-timers contest-notifier.timer
#   journalctl --user -u contest-notifier.service -n 50
#
# NOTE: the .service file hard-codes node's absolute path because nvm installs are
# absent from systemd's PATH. If you upgrade Node, update ExecStart:
#   ls -d ~/.nvm/versions/node/v*/
