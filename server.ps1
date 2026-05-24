param(
  [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$dataDir = Join-Path $root "data"
$matchesPath = Join-Path $dataDir "matches.json"
$predictionsPath = Join-Path $dataDir "predictions.json"
$usersPath = Join-Path $dataDir "users.json"
$sessions = @{}
$refreshState = @{
  sourceUrl = "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/match-schedule-fixtures-results-teams-stadiums"
  sourceLabel = "FIFA"
  lastSyncedAt = $null
  lastRefreshSucceeded = $false
}
$serverState = @{
  port = $Port
  shareUrls = @()
}
$configState = @{
  googleClientId = $null
  adminUsername = $null
  adminEmail = $null
  adminCode = $null
}

function Import-DotEnvFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }

  foreach ($line in (Get-Content -LiteralPath $Path)) {
    $trimmed = $line.Trim()

    if ([string]::IsNullOrWhiteSpace($trimmed) -or $trimmed.StartsWith("#")) {
      continue
    }

    $parts = $trimmed -split '=', 2

    if ($parts.Count -ne 2) {
      continue
    }

    $name = $parts[0].Trim()
    $value = $parts[1].Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    [Environment]::SetEnvironmentVariable($name, $value, "Process")
  }
}

function Get-ConfigValue {
  param([string]$Name)

  $value = [Environment]::GetEnvironmentVariable($Name, "Process")

  if ([string]::IsNullOrWhiteSpace($value)) {
    return $null
  }

  $value
}

Import-DotEnvFile -Path (Join-Path $root ".env")
Import-DotEnvFile -Path (Join-Path $root ".env.local")
$configState.googleClientId = Get-ConfigValue -Name "GOOGLE_CLIENT_ID"
$configState.adminCode = Get-ConfigValue -Name "ADMIN_CODE"
if ([string]::IsNullOrWhiteSpace($configState.adminCode)) {
  $configState.adminCode = "admin123"
}

function Test-IsAdminUser {
  param(
    [string]$Username,
    [string]$Email
  )
  $false
}

function Read-JsonFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }

  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Data
  )

  $json = $Data | ConvertTo-Json -Depth 100
  Set-Content -LiteralPath $Path -Value $json -Encoding UTF8
}

function Normalize-PlayerName {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }

  $Value.Trim().ToLowerInvariant()
}

function Get-PredictionsStore {
  $store = Read-JsonFile -Path $predictionsPath

  if ($null -eq $store) {
    $store = [pscustomobject]@{
      entries = @()
      participants = @()
    }
  }

  if ($null -eq $store.entries) {
    $store | Add-Member -NotePropertyName entries -NotePropertyValue @() -Force
  }

  if ($null -eq $store.participants) {
    $store | Add-Member -NotePropertyName participants -NotePropertyValue @() -Force
  }

  $store
}

function Ensure-ParticipantRegistered {
  param([string]$Name)

  if ([string]::IsNullOrWhiteSpace($Name)) {
    return
  }

  $store = Get-PredictionsStore
  $normalizedName = Normalize-PlayerName -Value $Name
  $existing = @($store.participants | Where-Object { (Normalize-PlayerName -Value $_.name) -eq $normalizedName }) | Select-Object -First 1

  if ($null -ne $existing) {
    return
  }

  $store.participants += [pscustomobject]@{
    name = $Name.Trim()
    joinedAt = [DateTime]::UtcNow.ToString("o")
  }

  Write-JsonFile -Path $predictionsPath -Data $store
}

function New-SessionId {
  [Guid]::NewGuid().ToString("N")
}

function ConvertTo-HexString {
  param([byte[]]$Bytes)

  ([System.BitConverter]::ToString($Bytes)).Replace("-", "").ToLowerInvariant()
}

function New-Salt {
  $bytes = New-Object byte[] 16
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
  } finally {
    $rng.Dispose()
  }
  ConvertTo-HexString -Bytes $bytes
}

function Get-PasswordHash {
  param(
    [string]$Password,
    [string]$Salt
  )

  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes("$Salt`:$Password")
    ConvertTo-HexString -Bytes ($sha.ComputeHash($bytes))
  } finally {
    $sha.Dispose()
  }
}

function Get-UsersStore {
  $store = Read-JsonFile -Path $usersPath

  if ($null -eq $store) {
    $store = [pscustomobject]@{ users = @() }
  }

  if ($null -eq $store.users) {
    $store.users = @()
  }

  $store
}

function Get-LocalIPv4Addresses {
  $addresses = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
    Where-Object {
      $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and
      -not $_.IPAddressToString.StartsWith("127.")
    } |
    ForEach-Object { $_.IPAddressToString } |
    Sort-Object -Unique

  @($addresses)
}

function Get-RefreshInfo {
  [pscustomobject]@{
    sourceUrl = $refreshState.sourceUrl
    sourceLabel = $refreshState.sourceLabel
    lastSyncedAt = $refreshState.lastSyncedAt
    lastRefreshSucceeded = $refreshState.lastRefreshSucceeded
  }
}

function Get-ServerInfo {
  [pscustomobject]@{
    port = $serverState.port
    shareUrls = @($serverState.shareUrls)
  }
}

function Get-GoogleAuthInfo {
  [pscustomobject]@{
    enabled = -not [string]::IsNullOrWhiteSpace($configState.googleClientId)
    clientId = $configState.googleClientId
  }
}

function Get-Outcome {
  param(
    [int]$Home,
    [int]$Away
  )

  if ($Home -eq $Away) { return "draw" }
  if ($Home -gt $Away) { return "home" }
  "away"
}

function Score-Prediction {
  param(
    [object]$Prediction,
    [object]$Match
  )

  if ($null -eq $Match.actual -or $null -eq $Match.actual.home -or $null -eq $Match.actual.away) {
    return @{ points = 0; exact = $false }
  }

  if ($null -eq $Prediction -or $Prediction.Count -ne 2) {
    return @{ points = 0; exact = $false }
  }

  $home = [int]$Prediction[0]
  $away = [int]$Prediction[1]
  $actualHome = [int]$Match.actual.home
  $actualAway = [int]$Match.actual.away

  if ($home -eq $actualHome -and $away -eq $actualAway) {
    return @{ points = 5; exact = $true }
  }

  if ((Get-Outcome -Home $home -Away $away) -eq (Get-Outcome -Home $actualHome -Away $actualAway)) {
    return @{ points = 3; exact = $false }
  }

  @{ points = 0; exact = $false }
}

function Get-ScoredEntries {
  $matches = @(Read-JsonFile -Path $matchesPath)
  $store = Get-PredictionsStore
  $entries = @($store.entries)

  $scored = foreach ($entry in $entries) {
    $points = 0
    $exact = 0

    foreach ($match in $matches) {
      $prediction = $entry.predictions.PSObject.Properties[$match.id].Value
      $score = Score-Prediction -Prediction $prediction -Match $match
      $points += [int]$score.points
      if ($score.exact) { $exact += 1 }
    }

    [pscustomobject]@{
      name = $entry.name
      updatedAt = $entry.updatedAt
      points = $points
      exact = $exact
      submitted = $true
    }
  }

  $joinedOnly = foreach ($participant in @($store.participants)) {
    $alreadySubmitted = @($entries | Where-Object { (Normalize-PlayerName -Value $_.name) -eq (Normalize-PlayerName -Value $participant.name) }).Count -gt 0

    if (-not $alreadySubmitted) {
      [pscustomobject]@{
        name = $participant.name
        updatedAt = $participant.joinedAt
        points = 0
        exact = 0
        submitted = $false
      }
    }
  }

  @($scored + $joinedOnly) | Sort-Object -Property @{ Expression = "points"; Descending = $true }, @{ Expression = "exact"; Descending = $true }, @{ Expression = "submitted"; Descending = $true }, @{ Expression = "name"; Descending = $false }
}

function Test-HasExistingSubmission {
  param([string]$Name)

  $store = Get-PredictionsStore
  if ($null -eq $store.entries) {
    return $false
  }

  $normalizedName = Normalize-PlayerName -Value $Name
  @($store.entries | Where-Object { (Normalize-PlayerName -Value $_.name) -eq $normalizedName }).Count -gt 0
}

function Get-FlagMap {
  @{
    "Algeria" = "🇩🇿"; "Argentina" = "🇦🇷"; "Australia" = "🇦🇺"; "Austria" = "🇦🇹"; "Belgium" = "🇧🇪";
    "Bolivia" = "🇧🇴"; "Bosnia and Herzegovina" = "🇧🇦"; "Brazil" = "🇧🇷"; "Cabo Verde" = "🇨🇻";
    "Canada" = "🇨🇦"; "Colombia" = "🇨🇴"; "Congo DR" = "🇨🇩"; "Costa Rica" = "🇨🇷";
    "Cote d'Ivoire" = "🇨🇮"; "Croatia" = "🇭🇷"; "Curacao" = "🇨🇼"; "Curaçao" = "🇨🇼";
    "Czechia" = "🇨🇿"; "Denmark" = "🇩🇰"; "Ecuador" = "🇪🇨"; "Egypt" = "🇪🇬"; "England" = "🏴";
    "France" = "🇫🇷"; "Germany" = "🇩🇪"; "Ghana" = "🇬🇭"; "Haiti" = "🇭🇹"; "IR Iran" = "🇮🇷";
    "Iraq" = "🇮🇶"; "Italy" = "🇮🇹"; "Jamaica" = "🇯🇲"; "Japan" = "🇯🇵"; "Jordan" = "🇯🇴";
    "Korea Republic" = "🇰🇷"; "Mexico" = "🇲🇽"; "Morocco" = "🇲🇦"; "Netherlands" = "🇳🇱";
    "New Zealand" = "🇳🇿"; "Norway" = "🇳🇴"; "Paraguay" = "🇵🇾"; "Panama" = "🇵🇦"; "Poland" = "🇵🇱";
    "Portugal" = "🇵🇹"; "Qatar" = "🇶🇦"; "Romania" = "🇷🇴"; "Saudi Arabia" = "🇸🇦"; "Scotland" = "🏴";
    "Senegal" = "🇸🇳"; "Slovakia" = "🇸🇰"; "South Africa" = "🇿🇦"; "Spain" = "🇪🇸"; "Sweden" = "🇸🇪";
    "Switzerland" = "🇨🇭"; "Tunisia" = "🇹🇳"; "Türkiye" = "🇹🇷"; "Turkey" = "🇹🇷"; "USA" = "🇺🇸";
    "Ukraine" = "🇺🇦"; "Uruguay" = "🇺🇾"; "Uzbekistan" = "🇺🇿"; "Wales" = "🏴"
  }
}

function Normalize-TeamName {
  param([string]$Name)

  $normalized = $Name.Trim() -replace '\s+', ' '
  $normalized = $normalized -replace 'Côte d''Ivoire', "Cote d'Ivoire"
  $normalized = $normalized -replace 'Curaçao', 'Curacao'
  $normalized
}

function Get-TeamFlag {
  param([string]$Name)

  $map = Get-FlagMap
  $normalized = Normalize-TeamName -Name $Name
  if ($map.ContainsKey($normalized)) { return $map[$normalized] }
  "🏳️"
}

function Normalize-StageLabel {
  param([string]$Stage)

  switch ($Stage) {
    "Bronze final" { "Third Place" }
    "Quarter-finals" { "Quarterfinal" }
    "Semi-finals" { "Semifinal" }
    default {
      if ($Stage -like "Group *") { "Group Stage" } else { $Stage }
    }
  }
}

function Get-TitleForStage {
  param([string]$Stage)

  if ($Stage -like "Group *") { return $Stage }

  switch ($Stage) {
    "Bronze final" { "Third-place Play-off" }
    default { $Stage }
  }
}

function New-MatchId {
  param(
    [string]$Stage,
    [string]$Home,
    [string]$Away,
    [string]$DateLabel
  )

  $base = "$Stage-$Home-$Away-$DateLabel".ToLowerInvariant() -replace '[^a-z0-9]+', '-'
  $base.Trim('-')
}

function Convert-HtmlToText {
  param([string]$Html)

  $text = $Html -replace '(?is)<script.*?</script>', ' '
  $text = $text -replace '(?is)<style.*?</style>', ' '
  $text = $text -replace '(?i)</(p|div|h1|h2|h3|h4|h5|h6|li|section|article|tr)>', "`n"
  $text = $text -replace '(?i)<br\s*/?>', "`n"
  $text = $text -replace '<[^>]+>', ' '
  $text = [System.Net.WebUtility]::HtmlDecode($text)
  $text = $text -replace [char]0x00A0, ' '
  $text = $text -replace [char]0x2013, ' - '
  $text = $text -replace [char]0x2014, ' - '
  $text = $text -replace '\s+\n', "`n"
  $text = $text -replace '\n\s+', "`n"
  $text = $text -replace '[ ]{2,}', ' '
  $text
}

function Get-FifaScheduleMatches {
  $venues = @(
    "Mexico City Stadium","Estadio Guadalajara","Toronto Stadium","Los Angeles Stadium","Boston Stadium",
    "BC Place Vancouver","New York New Jersey Stadium","San Francisco Bay Area Stadium","Philadelphia Stadium",
    "Houston Stadium","Dallas Stadium","Estadio Monterrey","Miami Stadium","Atlanta Stadium","Kansas City Stadium","Seattle Stadium"
  )

  $venuePattern = ($venues | ForEach-Object { [regex]::Escape($_) }) -join '|'
  $stagePattern = 'Group [A-L]|Round of 32|Round of 16|Quarter-finals|Semi-finals|Bronze final|Final'
  $datePattern = '^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{1,2} (June|July) 2026$'
  $fixturePattern = "(?<home>.+?) v (?<away>.+?)\s*-\s*(?<stage>$stagePattern)\s*-\s*(?<venue>$venuePattern)"

  $response = Invoke-WebRequest -Uri $refreshState.sourceUrl -UseBasicParsing
  $text = Convert-HtmlToText -Html $response.Content
  $lines = $text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ }

  $matches = @()
  $currentDate = $null
  $collecting = $false

  foreach ($line in $lines) {
    if ($line -eq "FIFA World Cup 2026 Group Stage fixtures") {
      $collecting = $true
      continue
    }

    if (-not $collecting) { continue }
    if ($line -match '^Tap for World Cup 2026 ticket information$') { break }

    if ($line -match $datePattern) {
      $currentDate = $line
      continue
    }

    if (-not $currentDate) { continue }

    $normalizedLine = $line -replace '\s+', ' '
    $fixtureMatches = [regex]::Matches($normalizedLine, $fixturePattern)

    foreach ($fixture in $fixtureMatches) {
      $rawStage = $fixture.Groups['stage'].Value.Trim()
      $home = Normalize-TeamName -Name $fixture.Groups['home'].Value
      $away = Normalize-TeamName -Name $fixture.Groups['away'].Value
      $venue = $fixture.Groups['venue'].Value.Trim()

      $matches += [pscustomobject]@{
        id = New-MatchId -Stage $rawStage -Home $home -Away $away -DateLabel $currentDate
        stage = Normalize-StageLabel -Stage $rawStage
        title = Get-TitleForStage -Stage $rawStage
        dateLabel = $currentDate
        venue = $venue
        home = $home
        away = $away
        homeFlag = Get-TeamFlag -Name $home
        awayFlag = Get-TeamFlag -Name $away
        actual = $null
        winnerNote = "Auto-updated from FIFA official schedule"
      }
    }
  }

  if ($matches.Count -lt 16) {
    throw "Unable to parse enough fixtures from FIFA schedule page."
  }

  $matches
}

function Try-RefreshMatches {
  try {
    $refreshState.lastSyncedAt = (Get-Item -LiteralPath $matchesPath).LastWriteTimeUtc.ToString("o")
    $refreshState.lastRefreshSucceeded = $true
    $true
  } catch {
    $refreshState.lastSyncedAt = $null
    $refreshState.lastRefreshSucceeded = $false
    $false
  }
}

function Parse-Cookies {
  param([hashtable]$Headers)

  $cookies = @{}

  if (-not $Headers.ContainsKey("cookie")) {
    return $cookies
  }

  foreach ($pair in ($Headers["cookie"] -split ';')) {
    $parts = $pair.Trim() -split '=', 2
    if ($parts.Count -eq 2) {
      $cookies[$parts[0].Trim()] = $parts[1].Trim()
    }
  }

  $cookies
}

function Get-AuthenticatedUser {
  param([hashtable]$Request)

  $sessionId = $Request.Cookies["pulse_session"]
  if ([string]::IsNullOrWhiteSpace($sessionId)) { return $null }
  $sessions[$sessionId]
}

function Get-StatusText {
  param([int]$StatusCode)

  switch ($StatusCode) {
    200 { "OK" }
    400 { "Bad Request" }
    401 { "Unauthorized" }
    403 { "Forbidden" }
    404 { "Not Found" }
    405 { "Method Not Allowed" }
    409 { "Conflict" }
    500 { "Internal Server Error" }
    default { "OK" }
  }
}

function Send-Response {
  param(
    [System.Net.Sockets.TcpClient]$Client,
    [int]$StatusCode,
    [string]$ContentType,
    [byte[]]$BodyBytes,
    [string[]]$ExtraHeaders = @()
  )

  $stream = $Client.GetStream()
  $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::ASCII, 1024, $true)
  $writer.NewLine = "`r`n"
  $writer.WriteLine("HTTP/1.1 $StatusCode $(Get-StatusText -StatusCode $StatusCode)")
  $writer.WriteLine("Content-Type: $ContentType")
  $writer.WriteLine("Content-Length: $($BodyBytes.Length)")
  $writer.WriteLine("Connection: close")
  foreach ($header in $ExtraHeaders) {
    $writer.WriteLine($header)
  }
  $writer.WriteLine("")
  $writer.Flush()
  $stream.Write($BodyBytes, 0, $BodyBytes.Length)
  $stream.Flush()
}

function Send-Json {
  param(
    [System.Net.Sockets.TcpClient]$Client,
    [object]$Body,
    [int]$StatusCode = 200,
    [string[]]$ExtraHeaders = @()
  )

  $json = $Body | ConvertTo-Json -Depth 100
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  Send-Response -Client $Client -StatusCode $StatusCode -ContentType "application/json; charset=utf-8" -BodyBytes $bytes -ExtraHeaders $ExtraHeaders
}

function Send-File {
  param(
    [System.Net.Sockets.TcpClient]$Client,
    [string]$Path
  )

  $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
  $contentType = switch ($extension) {
    ".html" { "text/html; charset=utf-8" }
    ".css" { "text/css; charset=utf-8" }
    ".js" { "application/javascript; charset=utf-8" }
    ".json" { "application/json; charset=utf-8" }
    default { "application/octet-stream" }
  }

  $bytes = [System.IO.File]::ReadAllBytes($Path)
  Send-Response -Client $Client -StatusCode 200 -ContentType $contentType -BodyBytes $bytes
}

function Set-SessionCookieHeader {
  param([string]$SessionId)
  "Set-Cookie: pulse_session=$SessionId; Path=/; HttpOnly; SameSite=Lax"
}

function Clear-SessionCookieHeader {
  "Set-Cookie: pulse_session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Lax"
}

function Parse-HttpRequest {
  param([System.Net.Sockets.TcpClient]$Client)

  $stream = $Client.GetStream()
  $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 8192, $true)
  $requestLine = $reader.ReadLine()

  if ([string]::IsNullOrWhiteSpace($requestLine)) {
    return $null
  }

  $parts = $requestLine -split ' '
  if ($parts.Count -lt 2) {
    throw "Malformed request line."
  }

  $method = $parts[0].ToUpperInvariant()
  $target = $parts[1]
  $headers = @{}

  while ($true) {
    $line = $reader.ReadLine()
    if ($null -eq $line -or $line -eq "") { break }
    $headerParts = $line -split ':', 2
    if ($headerParts.Count -eq 2) {
      $headers[$headerParts[0].Trim().ToLowerInvariant()] = $headerParts[1].Trim()
    }
  }

  $body = ""
  $contentLength = 0
  if ($headers.ContainsKey("content-length")) {
    [void][int]::TryParse($headers["content-length"], [ref]$contentLength)
  }

  if ($contentLength -gt 0) {
    $buffer = New-Object char[] $contentLength
    $read = 0
    while ($read -lt $contentLength) {
      $chunk = $reader.Read($buffer, $read, $contentLength - $read)
      if ($chunk -le 0) { break }
      $read += $chunk
    }
    $body = -join $buffer[0..($read - 1)]
  }

  $uri = [Uri]("http://localhost$target")
  @{
    Method = $method
    Path = $uri.AbsolutePath
    Query = $uri.Query
    Headers = $headers
    Body = $body
    Cookies = Parse-Cookies -Headers $headers
  }
}

function Read-RequestJson {
  param([hashtable]$Request)

  if ([string]::IsNullOrWhiteSpace($Request.Body)) {
    return @{}
  }

  $Request.Body | ConvertFrom-Json
}

function Verify-GoogleCredential {
  param([string]$Credential)

  if ([string]::IsNullOrWhiteSpace($Credential)) {
    throw "Google credential is missing."
  }

  if ([string]::IsNullOrWhiteSpace($configState.googleClientId)) {
    throw "Google sign-in is not configured on the server."
  }

  $encodedToken = [System.Uri]::EscapeDataString($Credential)
  $response = Invoke-WebRequest -Uri "https://oauth2.googleapis.com/tokeninfo?id_token=$encodedToken" -UseBasicParsing
  $payload = $response.Content | ConvertFrom-Json

  if ($payload.aud -ne $configState.googleClientId) {
    throw "Google token audience does not match this app."
  }

  if ($payload.iss -ne "accounts.google.com" -and $payload.iss -ne "https://accounts.google.com") {
    throw "Google token issuer is invalid."
  }

  if ($payload.email_verified -ne "true") {
    throw "Google account email is not verified."
  }

  [pscustomobject]@{
    username = $payload.name
    email = $payload.email
    picture = $payload.picture
    provider = "google"
    subject = $payload.sub
  }
}

function Get-BootstrapPayload {
  @{
    matches = @(Read-JsonFile -Path $matchesPath)
    leaderboard = @(Get-ScoredEntries)
    refreshInfo = Get-RefreshInfo
    serverInfo = Get-ServerInfo
  }
}

function Handle-Api {
  param(
    [System.Net.Sockets.TcpClient]$Client,
    [hashtable]$Request
  )

  $path = $Request.Path

  if ($path -eq "/api/auth/session" -and $Request.Method -eq "GET") {
    $user = Get-AuthenticatedUser -Request $Request

    if ($null -eq $user) {
      Send-Json -Client $Client -Body @{ authenticated = $false }
      return
    }

      Send-Json -Client $Client -Body @{
        authenticated = $true
        user = @{
          username = $user.username
          isAdmin = [bool]$user.isAdmin
        }
      }
    return
  }

  if ($path -eq "/api/auth/google/config" -and $Request.Method -eq "GET") {
    Send-Json -Client $Client -Body (Get-GoogleAuthInfo)
    return
  }

  if ($path -eq "/api/auth/google" -and $Request.Method -eq "POST") {
    try {
      $payload = Read-RequestJson -Request $Request
      $googleUser = Verify-GoogleCredential -Credential ([string]$payload.credential)
      Ensure-ParticipantRegistered -Name $googleUser.username
      $sessionId = New-SessionId
        $sessions[$sessionId] = @{
          username = $googleUser.username
          email = $googleUser.email
          picture = $googleUser.picture
          provider = "google"
          subject = $googleUser.subject
          isAdmin = Test-IsAdminUser -Username $googleUser.username -Email $googleUser.email
          createdAt = [DateTime]::UtcNow.ToString("o")
        }

        Send-Json -Client $Client -Body @{
          ok = $true
          user = @{
            username = $googleUser.username
            email = $googleUser.email
            provider = "google"
            isAdmin = Test-IsAdminUser -Username $googleUser.username -Email $googleUser.email
          }
        } -ExtraHeaders @(Set-SessionCookieHeader -SessionId $sessionId)
    } catch {
      Send-Json -Client $Client -Body @{ error = $_.Exception.Message } -StatusCode 401
    }
    return
  }

  if ($path -eq "/api/auth/register" -and $Request.Method -eq "POST") {
    $payload = Read-RequestJson -Request $Request
    $username = [string]$payload.username
    $password = [string]$payload.password

    if ($username.Trim().Length -lt 3) {
      Send-Json -Client $Client -Body @{ error = "Username must be at least 3 characters." } -StatusCode 400
      return
    }

    if ($password.Length -lt 6) {
      Send-Json -Client $Client -Body @{ error = "Password must be at least 6 characters." } -StatusCode 400
      return
    }

    $store = Get-UsersStore
    $normalized = $username.Trim()
    $existing = @($store.users | Where-Object { $_.username -eq $normalized })

    if ($existing.Count -gt 0) {
      Send-Json -Client $Client -Body @{ error = "Username already exists." } -StatusCode 409
      return
    }

    $salt = New-Salt
    $store.users += [pscustomobject]@{
      username = $normalized
      salt = $salt
      passwordHash = Get-PasswordHash -Password $password -Salt $salt
      createdAt = [DateTime]::UtcNow.ToString("o")
    }
    Write-JsonFile -Path $usersPath -Data $store

    $sessionId = New-SessionId
    $sessions[$sessionId] = @{ username = $normalized; createdAt = [DateTime]::UtcNow.ToString("o") }
    Send-Json -Client $Client -Body @{
      ok = $true
      user = @{ username = $normalized }
    } -ExtraHeaders @(Set-SessionCookieHeader -SessionId $sessionId)
    return
  }

  if ($path -eq "/api/auth/login" -and $Request.Method -eq "POST") {
    $payload = Read-RequestJson -Request $Request
    $username = [string]$payload.username
    $password = [string]$payload.password
    $store = Get-UsersStore
    $user = @($store.users | Where-Object { $_.username -eq $username.Trim() }) | Select-Object -First 1

    if ($null -eq $user) {
      Send-Json -Client $Client -Body @{ error = "Invalid username or password." } -StatusCode 401
      return
    }

    if ((Get-PasswordHash -Password $password -Salt $user.salt) -ne $user.passwordHash) {
      Send-Json -Client $Client -Body @{ error = "Invalid username or password." } -StatusCode 401
      return
    }

    $sessionId = New-SessionId
    $sessions[$sessionId] = @{ username = $user.username; createdAt = [DateTime]::UtcNow.ToString("o") }
    Send-Json -Client $Client -Body @{
      ok = $true
      user = @{ username = $user.username }
    } -ExtraHeaders @(Set-SessionCookieHeader -SessionId $sessionId)
    return
  }

  if ($path -eq "/api/auth/logout" -and $Request.Method -eq "POST") {
    $sessionId = $Request.Cookies["pulse_session"]
    if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
      $sessions.Remove($sessionId) | Out-Null
    }
    Send-Json -Client $Client -Body @{ ok = $true } -ExtraHeaders @(Clear-SessionCookieHeader)
    return
  }

  $authenticatedUser = Get-AuthenticatedUser -Request $Request
  if ($null -eq $authenticatedUser) {
    Send-Json -Client $Client -Body @{ error = "Authentication required." } -StatusCode 401
    return
  }

  if ($path -eq "/api/admin/unlock" -and $Request.Method -eq "POST") {
    $payload = Read-RequestJson -Request $Request
    $code = [string]$payload.code

    if ($code.Trim() -ne $configState.adminCode.Trim()) {
      Send-Json -Client $Client -Body @{ error = "Admin code is incorrect." } -StatusCode 403
      return
    }

    $authenticatedUser.isAdmin = $true
    Send-Json -Client $Client -Body @{
      ok = $true
      user = @{
        username = $authenticatedUser.username
        isAdmin = $true
      }
    }
    return
  }

  if ($path -eq "/api/bootstrap" -and $Request.Method -eq "GET") {
    Send-Json -Client $Client -Body (Get-BootstrapPayload)
    return
  }

  if ($path -eq "/api/leaderboard" -and $Request.Method -eq "GET") {
    Send-Json -Client $Client -Body @{
      leaderboard = @(Get-ScoredEntries)
    }
    return
  }

  if ($path -eq "/api/refresh" -and $Request.Method -eq "POST") {
    [void](Try-RefreshMatches)
    Send-Json -Client $Client -Body (Get-BootstrapPayload)
    return
  }

  if ($path -eq "/api/predictions" -and $Request.Method -eq "POST") {
    $payload = Read-RequestJson -Request $Request
    $name = [string]$payload.name

    if ([string]::IsNullOrWhiteSpace($name)) {
      Send-Json -Client $Client -Body @{ error = "Name is required." } -StatusCode 400
      return
    }

    if ($name -ne $authenticatedUser.username) {
      Send-Json -Client $Client -Body @{ error = "You can only submit picks for your signed-in account." } -StatusCode 403
      return
    }

    if (Test-HasExistingSubmission -Name $name) {
      Send-Json -Client $Client -Body @{ error = "This account already submitted picks and is now locked." } -StatusCode 403
      return
    }

    Ensure-ParticipantRegistered -Name $name
    $store = Get-PredictionsStore

    $entries = @($store.entries)
    $entries += [pscustomobject]@{
      name = $name
      updatedAt = [DateTime]::UtcNow.ToString("o")
      predictions = $payload.predictions
    }
    $store.entries = $entries
    Write-JsonFile -Path $predictionsPath -Data $store

    Send-Json -Client $Client -Body @{
      ok = $true
      leaderboard = @(Get-ScoredEntries)
    }
    return
  }

  if ($path -eq "/api/reset" -and $Request.Method -eq "POST") {
    Send-Json -Client $Client -Body @{ error = "Submitted entries are locked and cannot be reset." } -StatusCode 403
    return
  }

  Send-Json -Client $Client -Body @{ error = "Not found." } -StatusCode 404
}

function Handle-Static {
  param(
    [System.Net.Sockets.TcpClient]$Client,
    [hashtable]$Request
  )

  $relativePath = if ($Request.Path -eq "/") { "index.html" } else { $Request.Path.TrimStart("/") }
  $safePath = $relativePath -replace '/', '\'
  $fullPath = Join-Path $root $safePath

  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
    Send-Json -Client $Client -Body @{ error = "Not found." } -StatusCode 404
    return
  }

  Send-File -Client $Client -Path $fullPath
}

function Handle-Client {
  param([System.Net.Sockets.TcpClient]$Client)

  try {
    $request = Parse-HttpRequest -Client $Client
    if ($null -eq $request) { return }

    if ($request.Path.StartsWith("/api/")) {
      Handle-Api -Client $Client -Request $request
    } else {
      Handle-Static -Client $Client -Request $request
    }
  } catch {
    try {
      Send-Json -Client $Client -Body @{ error = $_.Exception.Message } -StatusCode 500
    } catch {
      # Ignore secondary write failures.
    }
  } finally {
    $Client.Close()
  }
}

[void](Try-RefreshMatches)

$serverState.shareUrls = @("http://localhost:$Port/", "http://127.0.0.1:$Port/") + ((Get-LocalIPv4Addresses) | ForEach-Object { "http://$_`:$Port/" })
$serverState.shareUrls = @($serverState.shareUrls | Sort-Object -Unique)

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
$listener.Start()

Write-Host "Pulse Cup Predictor server running at:"
foreach ($url in $serverState.shareUrls) {
  Write-Host " - $url"
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    Handle-Client -Client $client
  }
} finally {
  $listener.Stop()
}
