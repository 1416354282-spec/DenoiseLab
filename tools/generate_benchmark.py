#!/usr/bin/env python
"""DenoiseLab 离线基准生成器：合成 EEG + 可控伪迹 + 真实去噪算法。"""
from __future__ import annotations

import json
import zlib
from pathlib import Path

import numpy as np
import pywt
from scipy import signal
from sklearn.decomposition import FastICA

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data"
SFREQ = 250
DURATION = 40
N_TIMES = SFREQ * DURATION
CHANNELS = ["Fp1", "Fp2", "Fz", "Cz", "Pz", "Oz", "F3", "F4",
            "C3", "C4", "P3", "P4", "O1", "O2", "T3", "T4"]
DISPLAY_CHANNELS = ["Fp1", "Cz", "Oz"]
EVENTS = np.arange(1, DURATION, 2) * SFREQ
SNR_LEVELS = [-5, 0, 5]
ARTIFACTS = ["eog", "emg", "line", "drift"]
METHODS = ["bandpass", "notch", "wavelet", "ica", "asr"]
W_START, W_END = 6 * SFREQ, 10 * SFREQ


def weights(mapping):
    return np.array([mapping.get(ch, 0.15) for ch in CHANNELS])[:, None]


def pink_noise(rng, n):
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, 1 / SFREQ)
    freqs[0] = freqs[1]
    spec /= np.sqrt(freqs)
    out = np.fft.irfft(spec, n)
    return out / out.std()


def rhythm(rng, freq, n, burst=True):
    t = np.arange(n) / SFREQ
    phase = rng.uniform(0, 2 * np.pi)
    env = 1.0
    if burst:
        env = 0.6 + 0.4 * np.sin(2 * np.pi * 0.23 * t + rng.uniform(0, 6))
        env *= 0.7 + 0.6 * rng.random()
    return env * np.sin(2 * np.pi * freq * t + phase)


def make_clean(seed=20261106):
    rng = np.random.default_rng(seed)
    clean = np.zeros((len(CHANNELS), N_TIMES))
    sources = [
        (rhythm(rng, 10.0, N_TIMES) * 6.0,
         weights({"O1": 1, "O2": 1, "Oz": 1, "P3": .7, "P4": .7, "Pz": .7, "C3": .3, "C4": .3, "Cz": .3})),
        (rhythm(rng, 20.0, N_TIMES) * 2.5,
         weights({"C3": .8, "C4": .8, "Cz": .8, "F3": .5, "F4": .5, "Fz": .5, "T3": .4, "T4": .4})),
        (rhythm(rng, 6.0, N_TIMES) * 3.0,
         weights({"Fp1": .6, "Fp2": .6, "Fz": .6, "F3": .6, "F4": .6})),
    ]
    for src, w in sources:
        clean += w * src[None, :]
    for ch in range(len(CHANNELS)):
        clean[ch] += 3.0 * pink_noise(rng, N_TIMES)

    erp_map = np.zeros((len(CHANNELS), N_TIMES))
    for ev in EVENTS:
        jitter = int(rng.integers(-5, 6))
        t = (np.arange(N_TIMES) - ev - jitter) / SFREQ
        n400 = -8.0 * rng.uniform(.8, 1.2) * np.exp(-((t - .40) ** 2) / (2 * .06 ** 2))
        p100 = 4.0 * np.exp(-((t - .10) ** 2) / (2 * .025 ** 2))
        erp_map += weights({"Cz": 1, "Pz": .8, "C3": .7, "C4": .7, "Fz": .4}) * n400[None, :]
        erp_map += weights({"Oz": 1, "O1": .9, "O2": .9, "Pz": .5}) * p100[None, :]
    clean += erp_map
    return clean


def make_artifact(kind, rng):
    art = np.zeros((len(CHANNELS), N_TIMES))
    t = np.arange(N_TIMES) / SFREQ
    if kind == "eog":
        src = np.zeros(N_TIMES)
        for start in np.arange(2, DURATION - 1, 4.0):
            st = int((start + rng.uniform(-1, 1)) * SFREQ)
            tt = (np.arange(N_TIMES) - st) / SFREQ
            blink = np.where(tt >= 0, (1 - np.exp(-tt / .02)) * np.exp(-tt / .18), 0)
            src += rng.uniform(.7, 1.3) * blink
        art = weights({"Fp1": 1, "Fp2": 1, "Fz": .7, "F3": .6, "F4": .6,
                       "Cz": .3, "C3": .25, "C4": .25, "T3": .2, "T4": .2,
                       "P3": .1, "P4": .1, "Pz": .1, "O1": .05, "O2": .05, "Oz": .05}) * src[None, :]
    elif kind == "emg":
        src = np.zeros(N_TIMES)
        for start in np.arange(1, DURATION - 2, 3.0):
            st = int((start + rng.uniform(-.8, .8)) * SFREQ)
            ln = int(rng.uniform(.4, 1.2) * SFREQ)
            burst = rng.standard_normal(ln)
            burst = signal.sosfilt(signal.butter(4, [20, 100], "bandpass", fs=SFREQ, output="sos"), burst)
            src[st:st + ln] += burst * np.hanning(ln)
        art = weights({"T3": 1, "T4": 1, "C3": .6, "C4": .6, "F3": .5, "F4": .5, "Fp1": .2, "Fp2": .2}) * src[None, :]
    elif kind == "line":
        for ch in range(len(CHANNELS)):
            amp = rng.uniform(.6, 1.0)
            ph = rng.uniform(0, 2 * np.pi)
            art[ch] = amp * (np.sin(2 * np.pi * 50 * t + ph) + .3 * np.sin(2 * np.pi * 100 * t + ph))
    elif kind == "drift":
        for ch in range(len(CHANNELS)):
            slow = pink_noise(rng, N_TIMES)
            slow = signal.sosfilt(signal.butter(2, .5, "lowpass", fs=SFREQ, output="sos"), slow)
            art[ch] = slow / slow.std()
            if rng.random() < .5:
                st = int(rng.uniform(5, 30) * SFREQ)
                art[ch, st:] += rng.uniform(-2, 2)
    return art


def scale_to_snr(clean, art, snr_db):
    p_clean = np.mean(clean ** 2)
    p_art = np.mean(art ** 2)
    target = p_clean / (10 ** (snr_db / 10))
    return art * np.sqrt(target / p_art)


def bandpass(x):
    sos = signal.butter(4, [.5, 40], "bandpass", fs=SFREQ, output="sos")
    return signal.sosfiltfilt(sos, x, axis=-1)


def notch(x):
    b, a = signal.iirnotch(50, 30, SFREQ)
    y = signal.filtfilt(b, a, x, axis=-1)
    return bandpass(y)


def wavelet_denoise(x):
    out = np.zeros_like(x)
    for ch in range(x.shape[0]):
        coeffs = pywt.wavedec(x[ch], "db4", level=6)
        sigma = np.median(np.abs(coeffs[-1])) / .6745
        thr = sigma * np.sqrt(2 * np.log(x.shape[1]))
        coeffs[1:] = [pywt.threshold(c, thr, mode="soft") for c in coeffs[1:]]
        out[ch] = pywt.waverec(coeffs, "db4")[:x.shape[1]]
    return out


def band_ratio(sig, lo, hi):
    f, p = signal.welch(sig, fs=SFREQ, nperseg=512)
    total = np.trapezoid(p, f) + 1e-12
    band = np.trapezoid(p[(f >= lo) & (f < hi)], f[(f >= lo) & (f < hi)])
    return band / total


def ica_denoise(x, kind):
    n_ch = x.shape[0]
    ica = FastICA(n_components=n_ch, whiten="unit-variance", max_iter=600,
                  random_state=7, tol=1e-3)
    src = ica.fit_transform(x.T).T
    proxy = x[:2].mean(axis=0)
    scores = np.zeros(n_ch)
    for i in range(n_ch):
        if kind == "eog":
            scores[i] = abs(np.corrcoef(src[i], proxy)[0, 1])
        elif kind == "emg":
            scores[i] = band_ratio(src[i], 30, 100)
        elif kind == "line":
            scores[i] = band_ratio(src[i], 49, 51)
        else:
            scores[i] = band_ratio(src[i], 0, .5)
    order = np.argsort(scores)[::-1]
    remove = [i for i in order if scores[i] > {"eog": .45, "emg": .5, "line": .3, "drift": .5}[kind]]
    remove = remove[:3]
    if not remove:
        remove = [order[0]]
    src[remove] = 0
    return ica.inverse_transform(src.T).T


def asr_denoise(x, cutoff=15.0):
    win, step = SFREQ, SFREQ // 2
    starts = list(range(0, N_TIMES - win + 1, step))
    covs = []
    for st in starts:
        seg = x[:, st:st + win]
        covs.append(np.cov(seg) + 1e-6 * np.eye(x.shape[0]))
    activity = np.array([np.trace(c) for c in covs])
    calm = np.argsort(activity)[:max(3, len(starts) // 4)]
    ref = np.mean([covs[i] for i in calm], axis=0)
    d_ref, v_ref = np.linalg.eigh(ref)
    d_ref = np.maximum(d_ref, 1e-8)
    out = x.copy()
    for st in starts:
        seg = x[:, st:st + win]
        c = np.cov(seg) + 1e-6 * np.eye(x.shape[0])
        d, v = np.linalg.eigh(c)
        proj = v_ref.T @ v
        ratio = np.abs(proj) ** 2 @ (d / d_ref[:, None]).T
        strong = np.diag(ratio.max(axis=0) > cutoff).astype(float)
        if strong.sum() == 0:
            continue
        mixing = v_ref @ np.diag(d_ref ** .5)
        keep = np.eye(x.shape[0]) - strong
        clean_part = mixing @ keep @ np.linalg.pinv(mixing) @ seg
        out[:, st:st + win] = .5 * out[:, st:st + win] + .5 * clean_part
    return bandpass(out)


def erp_wave(x, ch_index):
    epochs = []
    for ev in EVENTS:
        if ev - 50 >= 0 and ev + 200 <= N_TIMES:
            epochs.append(x[ch_index, ev - 50:ev + 200])
    return np.mean(epochs, axis=0)


def bandpower(x, lo, hi):
    f, p = signal.welch(x, fs=SFREQ, nperseg=1024, axis=-1)
    mask = (f >= lo) & (f < hi)
    return np.trapezoid(p[..., mask], f[mask], axis=-1).mean()


def evaluate(out, clean, noisy):
    err = out - clean
    snr_out = 10 * np.log10(np.mean(clean ** 2) / (np.mean(err ** 2) + 1e-12))
    snr_in = 10 * np.log10(np.mean(clean ** 2) / (np.mean((noisy - clean) ** 2) + 1e-12))
    corrs = [np.corrcoef(out[c], clean[c])[0, 1] for c in range(out.shape[0])]
    rrmse = np.linalg.norm(err) / np.linalg.norm(clean)
    alpha = bandpower(out, 8, 13) / bandpower(clean, 8, 13)
    beta = bandpower(out, 13, 30) / bandpower(clean, 13, 30)
    cz = CHANNELS.index("Cz")
    e_out, e_clean = erp_wave(out, cz), erp_wave(clean, cz)
    search = slice(100, 175)  # 0.2–0.5 s，N400 搜索窗
    peak_out = e_out[search].min()
    peak_clean = e_clean[search].min()
    lat_out = (np.argmin(e_out[search]) + 100 - 50) / SFREQ * 1000
    lat_clean = (np.argmin(e_clean[search]) + 100 - 50) / SFREQ * 1000
    return {
        "snr_db": round(float(snr_out), 2),
        "snr_improvement": round(float(snr_out - snr_in), 2),
        "corr": round(float(np.mean(corrs)), 3),
        "rrmse": round(float(rrmse), 3),
        "alpha_ratio": round(float(alpha), 3),
        "beta_ratio": round(float(beta), 3),
        "erp_peak_ratio": round(float(peak_out / (peak_clean + 1e-9)), 3),
        "erp_latency_shift_ms": round(float(abs(lat_out - lat_clean)), 1),
    }


def psd_curve(x, ch_index):
    f, p = signal.welch(x[ch_index], fs=SFREQ, nperseg=1024)
    mask = f <= 60
    return 10 * np.log10(p[mask] + 1e-12)


def main():
    OUT.mkdir(exist_ok=True)
    clean = make_clean()
    f_psd = signal.welch(clean[0], fs=SFREQ, nperseg=1024)[0]
    psd_freqs = np.round(f_psd[f_psd <= 60], 2).tolist()
    erp_times = (np.arange(-50, 200) / SFREQ).round(3).tolist()
    summary = {"conditions": [], "methods": METHODS, "artifacts": ARTIFACTS,
               "snr_levels": SNR_LEVELS, "channels": CHANNELS}
    for kind in ARTIFACTS:
        for snr in SNR_LEVELS:
            rng = np.random.default_rng(zlib.crc32(f"{kind}_{snr}".encode()))
            noisy = clean + scale_to_snr(clean, make_artifact(kind, rng), snr)
            outputs = {"noisy": noisy, "clean": clean}
            outputs["bandpass"] = bandpass(noisy)
            outputs["notch"] = notch(noisy)
            outputs["wavelet"] = wavelet_denoise(noisy)
            outputs["ica"] = ica_denoise(noisy, kind)
            outputs["asr"] = asr_denoise(noisy)
            doc = {
                "artifact": kind, "snr": snr, "sfreq": SFREQ,
                "channels": CHANNELS, "display_channels": DISPLAY_CHANNELS,
                "window": [6, 10], "psd_freqs": psd_freqs, "erp_times": erp_times,
                "waveforms": {}, "psd": {}, "erp": {}, "metrics": {},
            }
            for name, arr in outputs.items():
                doc["waveforms"][name] = {
                    ch: np.round(arr[CHANNELS.index(ch), W_START:W_END], 3).tolist()
                    for ch in DISPLAY_CHANNELS
                }
                doc["psd"][name] = np.round(psd_curve(arr, CHANNELS.index("Cz")), 2).tolist()
                doc["erp"][name] = np.round(erp_wave(arr, CHANNELS.index("Cz")), 3).tolist()
                if name != "clean":
                    doc["metrics"][name] = evaluate(arr, clean, noisy)
            path = OUT / f"{kind}_{snr}.json"
            path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
            summary["conditions"].append({
                "artifact": kind, "snr": snr, "file": path.name,
                "metrics": doc["metrics"],
            })
            print(f"{path.name}: " + ", ".join(
                f"{m}: corr={doc['metrics'][m]['corr']}" for m in ["noisy"] + METHODS), flush=True)
    (OUT / "summary.json").write_text(json.dumps(summary, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
