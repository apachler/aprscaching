; TheNetNode configuration file — FIXED line order (';' lines are comments).
; Order per load_configuration() in src/file.c: passwords, ident, call,
; then the path set. Keep every line under 80 characters.
;
; NET/ROM sysop password (80 characters)
interop0interop1interop2interop3interop4interop5interop6interop7interop8inter90
;
; Console password
interop
;
; Node ident (alias, max 6 characters)
TNN
;
; Node callsign
OE9TNN
;
; Workpath (help files + startup TNB live here; TNN starts from here)
/opt/tnn/
;
; Path to the executable text files
/opt/tnn/textcmd/
;
; Path to the external programs for users
/opt/tnn/userexe/
;
; Path to the external programs for the sysop
/opt/tnn/sysexe/
;
; Path to the PACSAT files
/opt/tnn/pacsat/
;
; Path for the AXIPR HTML status files (rstat.html)
/opt/tnn/html/
