; SPDX-License-Identifier: AGPL-3.0-or-later
; Pomelo installer: per-user (no administrator rights), three screens: location, conversion engines, shortcuts.
; Build it with:  npm run package  then  npm run build:installer      (needs Inno Setup 6.3 or later)
;
; Silent install:   Pomelo-Setup-x64.exe /VERYSILENT                  app only, no engines (this is how Pomelo updates itself)
;                   Pomelo-Setup-x64.exe /VERYSILENT /ENGINES=pdf,soffice,pandoc
;                   add /WAITPID=<id> to wait for that process to exit first (Pomelo passes its own when it updates itself)

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Pomelo"
#define AppExe "Pomelo.exe"
#define AppUrl "https://github.com/zzvimalzz/pomelo"
#define BuildId "76597e8447ac0831cb436eb6501685f4cb4723d2dbc6d3b80f0da5ad348045f5"

[Setup]
AppId={{6F0C2E4A-3B1D-4D8E-9A57-C1E0B7F5A2D3}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
VersionInfoProductTextVersion={#AppVersion}+{#Copy(BuildId, 1, 12)}
AppPublisher=Vimal
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={autopf}\{#AppName}
PrivilegesRequired=lowest
MinVersion=10.0.17763
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
DisableWelcomePage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableDirPage=no
WizardStyle=modern
WizardImageFile=wizard-large.png
WizardSmallImageFile=wizard-small.png
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
OutputDir=..\dist\installer
OutputBaseFilename=Pomelo-Setup-x64
#ifdef FastBuild
Compression=lzma2/fast
#else
Compression=lzma2/max
#endif
SolidCompression=yes

[Files]
Source: "..\dist\Pomelo-win32-x64\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"
Name: "autostart"; Description: "Start Pomelo when Windows starts"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
; The conversion engines are installed from [Code] (InstallEngines) so the wizard can show their progress.
Filename: "{app}\{#AppExe}"; Description: "Launch Pomelo"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{userappdata}\{#AppName}"
; A second try at the engines folder, after Pomelo has stopped (the first is Pomelo.exe --uninstall-engines, in [Code])
Type: filesandordirs; Name: "{localappdata}\{#AppName}\engines"
Type: dirifempty; Name: "{localappdata}\{#AppName}"

[Code]
type
  TMsg = record
    hwnd: HWND;
    message: UINT;
    wParam: Longint;
    lParam: Longint;
    time: DWORD;
    pt: TPoint;
  end;

function GetTickCount: Cardinal;
  external 'GetTickCount@kernel32.dll stdcall';
function FindWindowEx(Parent, ChildAfter: Longint; ClassName, WindowName: String): Longint;
  external 'FindWindowExW@user32.dll stdcall';
function GetWindowThreadProcessId(Wnd: Longint; var ProcessId: DWORD): DWORD;
  external 'GetWindowThreadProcessId@user32.dll stdcall';
function PeekMessage(var Msg: TMsg; hWnd: HWND; MsgFilterMin, MsgFilterMax, RemoveMsg: UINT): BOOL;
  external 'PeekMessageW@user32.dll stdcall';
function TranslateMessage(const Msg: TMsg): BOOL;
  external 'TranslateMessage@user32.dll stdcall';
function DispatchMessage(const Msg: TMsg): Longint;
  external 'DispatchMessageW@user32.dll stdcall';
function OpenProcess(Access: DWORD; InheritHandle: BOOL; ProcessId: DWORD): Longint;
  external 'OpenProcess@kernel32.dll stdcall';
function WaitForSingleObject(Handle: Longint; Milliseconds: DWORD): DWORD;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function CloseHandle(Handle: Longint): BOOL;
  external 'CloseHandle@kernel32.dll stdcall';

// Sleep does not keep the window alive. Without this the wizard shows "Not responding" while the engines install.
procedure PumpMessages;
var
  Msg: TMsg;
begin
  while PeekMessage(Msg, 0, 0, 0, 1) do      // 1 = PM_REMOVE
  begin
    TranslateMessage(Msg);
    DispatchMessage(Msg);
  end;
end;

var
  EnginePage: TInputOptionWizardPage;
  FailedEngines: String;      // engines that could not be installed (shown on the finish page) or removed (shown after uninstalling)
  Updating: Boolean;          // a copy of Pomelo is already installed: this run replaces its program files and leaves everything else
  InstalledDir, InstalledVersion: String;

// ---- an existing copy -----------------------------------------------------------------------------------------

// Where the installed copy lives and which version it is. Windows' own record of the install (written by the installer)
// comes first; a copy that has no record (unpacked by hand, record lost) is found by looking in the default folder.
procedure FindInstalled;
var
  Key, Exe: String;
begin
  InstalledDir := '';
  InstalledVersion := '';
  Key := ExpandConstant('Software\Microsoft\Windows\CurrentVersion\Uninstall\{#SetupSetting("AppId")}_is1');
  if not RegQueryStringValue(HKCU, Key, 'Inno Setup: App Path', InstalledDir) then
    if not RegQueryStringValue(HKLM, Key, 'Inno Setup: App Path', InstalledDir) then
      InstalledDir := '';
  if (InstalledDir = '') or not FileExists(AddBackslash(InstalledDir) + '{#AppExe}') then
  begin
    InstalledDir := ExpandConstant('{autopf}\{#AppName}');
    if not FileExists(AddBackslash(InstalledDir) + '{#AppExe}') then
    begin
      InstalledDir := '';
      Exit;
    end;
  end;
  Exe := AddBackslash(InstalledDir) + '{#AppExe}';
  if not GetVersionNumbersString(Exe, InstalledVersion) then InstalledVersion := '';
  // The file version has four parts (0.1.2.0); Pomelo's versions have three.
  if (Length(InstalledVersion) > 2) and (Copy(InstalledVersion, Length(InstalledVersion) - 1, 2) = '.0') then
    Delete(InstalledVersion, Length(InstalledVersion) - 1, 2);
end;

// What Setup is about to do to the copy that is there, in words.
function ExistingCopyText: String;
var
  Have, Mine: Int64;
  Compared: Integer;
  Which: String;
begin
  if InstalledVersion = '' then Which := 'Pomelo' else Which := 'Pomelo ' + InstalledVersion;
  Result := Which + ' is already installed in:' + #13#10 + InstalledDir + #13#10#13#10;
  Compared := 0;
  if StrToVersion(InstalledVersion, Have) and StrToVersion('{#AppVersion}', Mine) then Compared := ComparePackedVersion(Have, Mine);
  if Compared > 0 then
    Result := Result + 'That is newer than this Setup (version {#AppVersion}). Continuing replaces it with the older version.'
  else if (Compared = 0) and (InstalledVersion <> '') then
    Result := Result + 'That is the same version as this Setup. Continuing installs it again over the existing files.'
  else
    Result := Result + 'Setup will update it to version {#AppVersion}.';
  Result := Result + #13#10#13#10 +
    'The program files are replaced. Your settings, shortcuts and conversion engines are kept. If Pomelo is running, Setup closes it first.';
end;

// When Pomelo updates itself it starts this Setup and then quits; stopping a Pomelo that has not finished quitting would also
// stop this Setup, which is still one of its children. So wait for that process (at most 30 seconds) before doing anything.
procedure WaitForPomeloToQuit;
var
  Pid: Integer;
  Handle: Longint;
begin
  Pid := StrToIntDef(ExpandConstant('{param:WAITPID|0}'), 0);
  if Pid <= 0 then Exit;
  Handle := OpenProcess($00100000, False, Pid);      // SYNCHRONIZE; 0 when the process is already gone
  if Handle = 0 then Exit;
  WaitForSingleObject(Handle, 30000);
  CloseHandle(Handle);
end;

function InitializeSetup: Boolean;
begin
  WaitForPomeloToQuit;
  FindInstalled;
  Updating := InstalledDir <> '';
  Result := True;
end;

procedure InitializeWizard;
begin
  if Updating then
  begin
    CreateOutputMsgPage(wpWelcome, 'Update Pomelo', 'A copy of Pomelo is already installed', ExistingCopyText);
    WizardForm.DirEdit.Text := RemoveBackslashUnlessRoot(InstalledDir);
  end;
  EnginePage :=CreateInputOptionPage(wpSelectDir, 'Conversion engines',
    'Optional extras for higher-quality conversions',
    'Pomelo works without these, and once installed everything runs offline. They are downloaded now, so you need an internet connection. You can add or remove them later in Settings.',
    False, False);
  EnginePage.Add('PDF to Word and more, scanned PDFs (OCR) and HEIC export (about 320 MB)');
  EnginePage.Add('LibreOffice, for Office formats (about 350 MB download, about 1 GB on disk)');
  EnginePage.Add('Pandoc, for Markdown, HTML, RTF and ODT (about 40 MB)');
  EnginePage.Values[0] := True;
  EnginePage.Values[1] := True;
  EnginePage.Values[2] := True;
end;

// The engine names Pomelo.exe --install-engines understands, comma separated.
function SelectedEngines(Param: String): String;
begin
  if WizardSilent then
  begin
    Result := ExpandConstant('{param:ENGINES|}');
    Exit;
  end;
  Result := '';
  if Updating then Exit;      // the engines page is skipped for an update: engines stay as they are
  if EnginePage.Values[0] then Result := Result + ',pdf';
  if EnginePage.Values[1] then Result := Result + ',soffice';
  if EnginePage.Values[2] then Result := Result + ',pandoc';
  if Result <> '' then Delete(Result, 1, 1);
end;

function EnginesSelected: Boolean;
begin
  Result := SelectedEngines('') <> '';
end;

// ---- progress ------------------------------------------------------------------------------------------------

// Pomelo.exe keeps its progress in a small text file of key=value lines; this reads one value.
function ProgressField(const Text, Name: String): String;
var
  P, EndCr, EndLf: Integer;
  S: String;
begin
  Result := '';
  P := Pos(#10 + Name + '=', #10 + Text);
  if P = 0 then Exit;
  S := Copy(Text, P + Length(Name) + 1, MaxInt);
  EndCr := Pos(#13, S);
  EndLf := Pos(#10, S);
  if (EndCr = 0) or ((EndLf > 0) and (EndLf < EndCr)) then EndCr := EndLf;
  if EndCr = 0 then Result := S else Result := Copy(S, 1, EndCr - 1);
end;

function ElapsedText(Since: Cardinal): String;
var
  Seconds: Cardinal;
  Rest: String;
begin
  Seconds := (GetTickCount - Since) div 1000;
  Rest := IntToStr(Seconds mod 60);
  if Length(Rest) < 2 then Rest := '0' + Rest;
  Result := IntToStr(Seconds div 60) + ':' + Rest;
end;

// Runs Pomelo.exe with an engine switch and mirrors its progress into the given labels and bar until it says it is done.
// Returns the engines that failed, as text ('' when all went well).
function RunEngineStep(const Switch: String; Status, Detail: TNewStaticText; Bar: TNewProgressBar): String;
var
  ProgressFile, Text: String;
  Raw: AnsiString;
  Code: Integer;
  Started, LastRead: Cardinal;
  OldMin, OldMax, OldPosition: Longint;
  Seen, Finished: Boolean;
begin
  Result := '';
  ProgressFile := ExpandConstant('{tmp}\pomelo-progress.txt');
  DeleteFile(ProgressFile);
  OldMin := Bar.Min;
  OldMax := Bar.Max;
  OldPosition := Bar.Position;
  Bar.Min := 0;
  Bar.Max := 1000;
  Bar.Position := 0;
  Status.Caption := 'Starting...';
  if Detail <> Status then Detail.Caption := '';
  if Exec(ExpandConstant('{app}\{#AppExe}'), Switch + ' "--progress-file=' + ProgressFile + '"', '', SW_HIDE, ewNoWait, Code) then
  begin
    Started := GetTickCount;
    LastRead := 0;
    Seen := False;
    Finished := False;
    while (not Finished) and ((GetTickCount - Started) < 3600000) do
    begin
      PumpMessages;
      Sleep(40);
      if (GetTickCount - LastRead) < 250 then Continue;
      LastRead := GetTickCount;
      if LoadStringFromFile(ProgressFile, Raw) then
      begin
        Seen := True;
        Text := String(Raw);
        Bar.Position := StrToIntDef(ProgressField(Text, 'permille'), Bar.Position);
        Status.Caption := ProgressField(Text, 'text') + '  ' + IntToStr(Bar.Position div 10) + '%  (' + ElapsedText(Started) + ')';
        if Detail <> Status then Detail.Caption := ProgressField(Text, 'detail');
        if ProgressField(Text, 'done') = '1' then
        begin
          Finished := True;
          Result := ProgressField(Text, 'failed');
        end;
      end
      else if (not Seen) and ((GetTickCount - Started) > 120000) then
        Finished := True;     // Pomelo never reported anything: carry on rather than wait forever
    end;
  end;
  Bar.Min := OldMin;
  Bar.Max := OldMax;
  Bar.Position := OldPosition;
end;

// The process that owns Pomelo's "only one copy" lock, whatever it is called and wherever it was started from, or 0. Pomelo
// keeps that lock as a hidden window named after its data folder, so a copy that was started from source (electron.exe)
// or from another folder is found just like the installed Pomelo.exe.
function LockOwner: DWORD;
var
  Wnd: Longint;
begin
  Result := 0;
  Wnd := FindWindowEx(-3, 0, 'Chrome_MessageWindow', ExpandConstant('{userappdata}\{#AppName}'));     // -3 = HWND_MESSAGE
  if Wnd <> 0 then GetWindowThreadProcessId(Wnd, Result);
end;

procedure Kill(const Args: String);
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), Args, '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

procedure StopPomelo;
var
  Owner: DWORD;
  Tries: Integer;
begin
  Tries := 0;
  Owner := LockOwner;
  while (Owner <> 0) and (Tries < 5) do
  begin
    Kill('/F /T /PID ' + IntToStr(Owner));
    Sleep(300);
    Owner := LockOwner;
    Tries := Tries + 1;
  end;
  Kill('/F /T /IM {#AppExe}');
  Kill('/F /IM pomelo-input.exe');          // the mouse helper; it can outlive a Pomelo that was ended abruptly
end;

// ---- install -------------------------------------------------------------------------------------------------

// Pomelo cannot be replaced while it runs, and a copy left running would keep answering when the new one is started
// (it holds the lock), so the old version would still be what opens. Better to stop here than to finish like that.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopPomelo;
  Result := '';
  if LockOwner <> 0 then
    Result := 'Pomelo is still running and Setup could not close it. Quit Pomelo from its tray icon (or end it in Task Manager), then run Setup again.';
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  // An update goes into the folder Pomelo is already in, and leaves the engines as they are.
  Result := Updating and ((PageID = wpSelectDir) or ((EnginePage <> nil) and (PageID = EnginePage.ID)));
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  SettingsFile: String;
begin
  // "Start Pomelo when Windows starts" unticked on a fresh install: start with that setting off. Existing settings are never touched.
  if CurStep = ssInstall then
  begin
    SettingsFile := ExpandConstant('{userappdata}\{#AppName}\settings.json');
    if (not WizardIsTaskSelected('autostart')) and (not FileExists(SettingsFile)) then
    begin
      ForceDirectories(ExtractFileDir(SettingsFile));
      SaveStringToFile(SettingsFile, '{"openAtLogin":false}', False);
    end;
  end;
  // The engines are installed by Pomelo itself (the code behind the Install buttons in Settings). A failed engine does not
  // fail the install: the finish page says which one to add later.
  if (CurStep = ssPostInstall) and EnginesSelected then
    FailedEngines := RunEngineStep('--install-engines=' + SelectedEngines(''), WizardForm.StatusLabel, WizardForm.FilenameLabel, WizardForm.ProgressGauge);
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and (FailedEngines <> '') then
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 +
      'These conversion engines could not be installed: ' + FailedEngines + '. You can add them later in Pomelo, Settings, Advanced.';
end;

// ---- uninstall -----------------------------------------------------------------------------------------------

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  EnginesFolder, Message: String;
begin
  // Stop Pomelo first (and with it any LibreOffice it started, which would keep files locked), then remove the engines
  // Pomelo installed and its "Start with Windows" entry, with progress.
  if CurUninstallStep = usUninstall then
  begin
    UninstallProgressForm.StatusLabel.Caption := 'Stopping Pomelo...';
    StopPomelo;
    FailedEngines := RunEngineStep('--uninstall-engines', UninstallProgressForm.StatusLabel, UninstallProgressForm.StatusLabel, UninstallProgressForm.ProgressBar);
    UninstallProgressForm.StatusLabel.Caption := 'Removing Pomelo...';
  end;
  // Only speak up if something is really still there, and say exactly where.
  if CurUninstallStep = usDone then
  begin
    EnginesFolder := ExpandConstant('{localappdata}\{#AppName}\engines');
    Message := '';
    if DirExists(EnginesFolder) then
      Message := Message + 'LibreOffice and the PDF components are plain folders. To finish, delete this one:' + #13#10 + EnginesFolder + #13#10#13#10;
    if (Pos('Pandoc', FailedEngines) > 0) or (Pos('Python', FailedEngines) > 0) then
      Message := Message + 'Pandoc and Python can be removed in Windows Settings, Apps.';
    if Message <> '' then
      MsgBox('Pomelo is removed, but part of the optional engines is still on this PC.' + #13#10#13#10 + Message, mbInformation, MB_OK);
  end;
end;
