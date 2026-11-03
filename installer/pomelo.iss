; SPDX-License-Identifier: AGPL-3.0-or-later
; Pomelo installer: per-user (no administrator rights), three screens: location, conversion engines, shortcuts.
; Build it with:  npm run package  then  npm run build:installer      (needs Inno Setup 6.3 or later)
;
; Silent install:   Pomelo-Setup-x64.exe /SILENT                      app only, no engines (this is how Pomelo updates itself)
;                   Pomelo-Setup-x64.exe /SILENT /ENGINES=pdf2docx,soffice,pandoc

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#define AppName "Pomelo"
#define AppExe "Pomelo.exe"
#define AppUrl "https://github.com/zzvimalzz/pomelo"

[Setup]
AppId={{6F0C2E4A-3B1D-4D8E-9A57-C1E0B7F5A2D3}
AppName={#AppName}
AppVersion={#AppVersion}
VersionInfoVersion={#AppVersion}
AppPublisher=Pomelo contributors
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
function PeekMessage(var Msg: TMsg; hWnd: HWND; MsgFilterMin, MsgFilterMax, RemoveMsg: UINT): BOOL;
  external 'PeekMessageW@user32.dll stdcall';
function TranslateMessage(const Msg: TMsg): BOOL;
  external 'TranslateMessage@user32.dll stdcall';
function DispatchMessage(const Msg: TMsg): Longint;
  external 'DispatchMessageW@user32.dll stdcall';

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

procedure InitializeWizard;
begin
  EnginePage := CreateInputOptionPage(wpSelectDir, 'Conversion engines',
    'Optional extras for higher-quality conversions',
    'Pomelo works without these, and once installed everything runs offline. They are downloaded now, so you need an internet connection. You can add or remove them later in Settings.',
    False, False);
  EnginePage.Add('PDF fidelity and HEIC export (about 150 MB)');
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
  if EnginePage.Values[0] then Result := Result + ',pdf2docx';
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

procedure StopPomelo;
var
  Code: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM {#AppExe}', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

// ---- install -------------------------------------------------------------------------------------------------

// Pomelo cannot be replaced while it runs.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopPomelo;
  Result := '';
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
