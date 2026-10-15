# peb_env.ps1 — read an environment variable from another process's PEB (Windows-only, no Python).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File peb_env.ps1 <ENV_NAME> [PID]
# Prints the value to stdout and exits 0 on success, 1 on failure.

param(
  [string]$Key = "OPENCODE_SERVER_PASSWORD",
  [int]$Pid_ = 0
)

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public static class PebEnv {
  const uint PROCESS_QUERY_INFORMATION = 0x0400;
  const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  const uint PROCESS_VM_READ = 0x0010;
  const int ProcessBasicInformation = 0;
  const int STATUS_SUCCESS = 0;

  [StructLayout(LayoutKind.Sequential)]
  public struct PBI {
    public IntPtr Reserved1;
    public IntPtr PebBaseAddress;
    public IntPtr Reserved2_0;
    public IntPtr Reserved2_1;
    public IntPtr UniqueProcessId;
    public IntPtr Reserved3;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool CloseHandle(IntPtr h);

  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int size, IntPtr retLen);

  static byte[] ReadMem(IntPtr h, IntPtr addr, int size) {
    var buf = new byte[size];
    IntPtr read;
    if (!ReadProcessMemory(h, addr, buf, (IntPtr)size, out read) || read == IntPtr.Zero) return null;
    int n = read.ToInt32();
    if (n == size) return buf;
    var trimmed = new byte[n];
    Array.Copy(buf, trimmed, n);
    return trimmed;
  }

  static IntPtr ReadPtr(IntPtr h, IntPtr addr) {
    var b = ReadMem(h, addr, 8);
    if (b == null || b.Length < 8) return IntPtr.Zero;
    return (IntPtr)BitConverter.ToInt64(b, 0);
  }

  static string ReadEnvBlock(IntPtr h, IntPtr envAddr) {
    var chunks = new List<byte>();
    var addr = envAddr;
    long total = 0;
    while (total < (1L << 20)) {
      var data = ReadMem(h, addr, 4096);
      if (data == null || data.Length == 0) break;
      chunks.AddRange(data);
      addr = (IntPtr)(addr.ToInt64() + data.Length);
      total += data.Length;
      if (data.Length < 4096) break;
    }
    if (chunks.Count == 0) return null;
    return Encoding.Unicode.GetString(chunks.ToArray());
  }

  public static string Get(string key, int pid) {
    IntPtr h = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
    if (h == IntPtr.Zero)
      h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      var pbi = new PBI();
      if (NtQueryInformationProcess(h, ProcessBasicInformation, ref pbi, Marshal.SizeOf(typeof(PBI)), IntPtr.Zero) != STATUS_SUCCESS)
        return null;
      if (pbi.PebBaseAddress == IntPtr.Zero) return null;
      var procParams = ReadPtr(h, (IntPtr)(pbi.PebBaseAddress.ToInt64() + 0x20));
      if (procParams == IntPtr.Zero) return null;
      var envAddr = ReadPtr(h, (IntPtr)(procParams.ToInt64() + 0x80));
      if (envAddr == IntPtr.Zero) return null;
      var raw = ReadEnvBlock(h, envAddr);
      if (raw == null) return null;
      var norm = key + "=";
      int i = 0;
      while (i < raw.Length) {
        int end = raw.IndexOf('\0', i);
        if (end < 0) end = raw.Length;
        string entry = raw.Substring(i, end - i);
        i = end + 1;
        if (entry.Length == 0) break;
        if (entry.StartsWith(norm, StringComparison.OrdinalIgnoreCase))
          return entry.Substring(norm.Length);
      }
      return null;
    } finally {
      CloseHandle(h);
    }
  }

  public static int[] PidsOfImage(string name) {
    var result = new List<int>();
    var psi = new System.Diagnostics.ProcessStartInfo("tasklist",
      "/FI \"IMAGENAME eq " + name + "\" /FO CSV /NH") {
      RedirectStandardOutput = true,
      UseShellExecute = false,
      CreateNoWindow = true
    };
    using (var p = System.Diagnostics.Process.Start(psi)) {
      string line;
      while ((line = p.StandardOutput.ReadLine()) != null) {
        var parts = line.Trim().Trim('"').Split(new[] { "\",\"" }, StringSplitOptions.None);
        if (parts.Length >= 2 && parts[0].Equals(name, StringComparison.OrdinalIgnoreCase)) {
          int pid;
          if (int.TryParse(parts[1], out pid)) result.Add(pid);
        }
      }
    }
    return result.ToArray();
  }
}
"@

Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop

$pids = @()
if ($Pid_ -gt 0) { $pids = @($Pid_) }
else { $pids = [PebEnv]::PidsOfImage("OpenCode.exe") }

foreach ($procId in $pids) {
  $val = [PebEnv]::Get($Key, $procId)
  if ($val) {
    Write-Output $val
    exit 0
  }
}
exit 1
