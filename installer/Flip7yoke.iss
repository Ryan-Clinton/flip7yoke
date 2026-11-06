; Flip7yoke installer (Inno Setup 6.7). Build with `node tools/build-installer.js`, which builds the exe,
; stamps the version into the control window and runs ISCC with /DAppVersion=<package.json version>.
; Per-user: no admin needed, except one UAC prompt for the optional firewall rule.
; Data and settings live in %LOCALAPPDATA%\Flip7yoke, outside the program folder: upgrades never touch them,
; and uninstalling keeps them unless the user says otherwise.

#ifndef AppVersion
  #error Build with tools/build-installer.js (it passes /DAppVersion)
#endif
#define AppExe "Flip7yoke-server.exe"
#define PS "{sys}\WindowsPowerShell\v1.0\powershell.exe"
; Single-quoted so the doubled quotes reach Inno as written (Inno reads "" inside a parameter as one quote).
#define PSArgs '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ""{app}\Flip7yoke.ps1""'

[Setup]
; Never change AppId: it is how a later installer recognises an existing install as an upgrade.
AppId={{D666137D-4314-4D87-8F41-51FD6EF34C2F}
AppName=Flip7yoke
AppVersion={#AppVersion}
AppVerName=Flip7yoke {#AppVersion}
AppPublisher=Flip7yoke (unofficial, not affiliated with The Op)
AppPublisherURL=https://github.com/Ryan-Clinton/flip7yoke
AppComments=Unofficial score keeper for Flip 7. Not affiliated with The Op.
VersionInfoVersion={#AppVersion}
VersionInfoDescription=Flip7yoke setup
DefaultDirName={autopf}\Flip7yoke
DisableDirPage=yes
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=Flip7yoke-Setup-{#AppVersion}
SetupIconFile=..\assets\flip7yoke.ico
UninstallDisplayIcon={app}\flip7yoke.ico
UninstallDisplayName=Flip7yoke
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
; We stop the server ourselves (through its supervisor, so the game is saved) instead of Windows closing it.
CloseApplications=no
RestartApplications=no

[Messages]
WelcomeLabel2=This will install Flip7yoke [name/ver], a score keeper for Flip 7 game nights: a big scoreboard on this PC, and everyone scores on their own phone over your Wi-Fi.%n%nUnofficial score keeper for Flip 7. Not affiliated with The Op.%n%nYour scores and settings are kept in your own user folder. Upgrading never touches them.
FinishedLabel=Flip7yoke is installed. Open it from the Start menu or the desktop, press Start, and the scoreboard opens in your browser.%n%nIf you skipped the firewall step or said No, phones can't connect yet: press Allow phones in the Flip7yoke window.

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut"
Name: firewall; Description: "Let phones on your home Wi-Fi connect (adds a Windows Firewall rule for private networks; Windows asks for permission)"
Name: reader; Description: "Set up the card reader for photo scoring (downloads about 4 GB; needs a graphics card with 6 GB or more for good speed)"; Flags: unchecked

[Files]
Source: "..\dist\{#AppExe}"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\build\installer\Flip7yoke.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\assets\flip7yoke.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; DestName: "LICENSE.txt"; Flags: ignoreversion
Source: "..\THIRD-PARTY-NOTICES.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\licenses\*"; DestDir: "{app}\licenses"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Flip7yoke"; Filename: "{#PS}"; Parameters: "{#PSArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\flip7yoke.ico"; Comment: "Start and stop the Flip 7 score keeper"
Name: "{autodesktop}\Flip7yoke"; Filename: "{#PS}"; Parameters: "{#PSArgs}"; WorkingDir: "{app}"; IconFilename: "{app}\flip7yoke.ico"; Comment: "Start and stop the Flip 7 score keeper"; Tasks: desktopicon

[Run]
; The control window does the firewall rule itself (only if it's missing), so the window's Allow phones button and
; this step are the same code. Declining the UAC prompt leaves the install complete.
Filename: "{#PS}"; Parameters: "{#PSArgs} -Action allow-phones"; Tasks: firewall; Flags: runhidden waituntilterminated; StatusMsg: "Asking Windows to let phones connect..."
; Card reader: a visible console window with progress; the installer doesn't wait for the 4 GB download.
Filename: "{#PS}"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\Flip7yoke.ps1"" -Action setup-reader"; Tasks: reader; Flags: nowait
Filename: "{#PS}"; Parameters: "{#PSArgs}"; Description: "Launch Flip7yoke"; Flags: postinstall nowait skipifsilent

[UninstallDelete]
; Anything the program made in its own folder (it shouldn't: data goes to %LOCALAPPDATA%\Flip7yoke).
Type: dirifempty; Name: "{app}\logs"
Type: dirifempty; Name: "{app}"

[UninstallRun]
Filename: "{#PS}"; Parameters: "{#PSArgs} -Action remove-firewall"; RunOnceId: "RemoveFirewallRule"; Flags: runhidden waituntilterminated

[Code]
// Stop a running Flip7yoke through its supervisor, so the current game is saved first.
// Returns False if it is still running afterwards (Flip7yoke.ps1 -Action stop exits with 3).
function StopFlip7yoke(): Boolean;
var
  Script: String;
  Code: Integer;
begin
  Result := True;
  Script := ExpandConstant('{app}\Flip7yoke.ps1');
  if not FileExists(Script) then Exit;
  if Exec(ExpandConstant('{#PS}'), '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + Script + '" -Action stop',
          '', SW_HIDE, ewWaitUntilTerminated, Code) then
    Result := (Code <> 3);
end;

// Upgrades: stop the old version before replacing its files. If it won't stop, change nothing.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if not StopFlip7yoke() then
    Result := 'Flip7yoke is still running and could not be stopped. Close it (press Stop in the Flip7yoke window) and run Setup again. Nothing was changed.';
end;

function InitializeUninstall(): Boolean;
begin
  Result := StopFlip7yoke();
  if not Result then
    MsgBox('Flip7yoke is still running and could not be stopped. Press Stop in the Flip7yoke window, then uninstall again.', mbError, MB_OK);
end;

// After the program is removed: offer to delete the scores and settings too. The default is to keep them.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Data: String;
begin
  if CurUninstallStep <> usPostUninstall then Exit;
  Data := ExpandConstant('{localappdata}\Flip7yoke');
  if not DirExists(Data) then Exit;
  if UninstallSilent() then Exit;
  if MsgBox('Also delete your Flip7yoke score history and settings?' + #13#10 + #13#10 + Data + #13#10 + #13#10 +
            'Choose No to keep them for a later reinstall.', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
    DelTree(Data, True, True, True);
end;
