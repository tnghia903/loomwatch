; LoomWatch-windows-setup.exe: installs LoomWatch for the person running it, with no administrator
; needed, the way LoomWatch.app is dragged to Applications on a Mac. Built by
; scripts/package-windows-app.ps1 with Inno Setup 6 from the files of loomwatch-windows-x86_64.zip,
; so both ways of installing put the same files in place.
;
; It puts LoomWatch in %LOCALAPPDATA%\Programs\LoomWatch, adds it to the Start menu, and opens it.
; Running a newer one over it is how LoomWatch is updated: it asks the running LoomWatch to quit
; first (LoomWatch.exe --quit), and opens the new one afterwards. Teams and run history live
; elsewhere (%USERPROFILE%\LoomWatch\teams and %LOCALAPPDATA%\LoomWatch), so updating and removing
; LoomWatch both leave them alone.
;
; Update and restart in LoomWatch runs it silently with /UPDATEDFROM=<the version it replaces>.
; Then it opens LoomWatch again in the background when it is done, as LoomWatch's page waits for it,
; or, when the new files could not be put in place, the version still there with --update-failed.

#ifndef Version
  #error Pass /DVersion=x.y.z
#endif
#ifndef Stage
  #error Pass /DStage=<the unpacked loomwatch folder>
#endif
#ifndef Output
  #define Output "."
#endif

[Setup]
; Never change: Windows knows an installed LoomWatch by it, to update and to remove it.
AppId={{6F0E5C2A-7C4B-4E3A-9B1D-4C6A2F8E1B57}
AppName=LoomWatch
AppVersion={#Version}
AppVerName=LoomWatch {#Version}
AppPublisher=LoomWatch
AppPublisherURL=https://loomwatch.github.io
AppSupportURL=https://github.com/tnghia903/loomwatch/issues
AppUpdatesURL=https://github.com/tnghia903/loomwatch/releases
DefaultDirName={localappdata}\Programs\LoomWatch
DisableDirPage=yes
DefaultGroupName=LoomWatch
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#Output}
OutputBaseFilename=LoomWatch-windows-setup
SetupIconFile=LoomWatch.ico
UninstallDisplayIcon={app}\LoomWatch.exe
UninstallDisplayName=LoomWatch
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; LoomWatch is asked to quit by the code below; the Restart Manager would only find it again.
CloseApplications=no
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Put LoomWatch on the desktop"; Flags: unchecked

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\LoomWatch"; Filename: "{app}\LoomWatch.exe"; Comment: "Put AI agents to work as one team"
Name: "{userdesktop}\LoomWatch"; Filename: "{app}\LoomWatch.exe"; Tasks: desktopicon

[Registry]
; Start at sign-in is the app's own menu item; removing LoomWatch removes it too.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "LoomWatch"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\LoomWatch.exe"; Description: "Open LoomWatch"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\LoomWatch.exe"; Parameters: "--quit"; Flags: runhidden waituntilterminated; RunOnceId: "QuitLoomWatch"

[Code]
var
  // Set once every file is in place.
  Installed: Boolean;

// An update replaces the files of a LoomWatch that may be running: ask it to quit as its own
// menu would, so it stops its runs and writes what it holds, and wait until it has.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Running: String;
  ResultCode: Integer;
begin
  Running := ExpandConstant('{app}\LoomWatch.exe');
  if FileExists(Running) then
    Exec(Running, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    Installed := True;
end;

// Run by LoomWatch's Update and restart: open LoomWatch again whether or not the update finished,
// the new version or the one still here, which then says the update didn't finish.
procedure DeinitializeSetup();
var
  App: String;
  Arguments: String;
  ResultCode: Integer;
begin
  if ExpandConstant('{param:UPDATEDFROM|}') = '' then
    Exit;
  try
    App := ExpandConstant('{app}\LoomWatch.exe');
  except
    Exit;
  end;
  if not FileExists(App) then
    Exit;
  Arguments := '--background';
  if not Installed then
    Arguments := Arguments + ' --update-failed';
  Exec(App, Arguments, '', SW_SHOWNORMAL, ewNoWait, ResultCode);
end;
