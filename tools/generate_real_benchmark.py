#!/usr/bin/env python
"""真实背景基准：PhysioNet EEGBCI S001R02（眼闭静息）+ 可控伪迹与 ERP。"""
from __future__ import annotations

import json
import zlib
from pathlib import Path

import edfio
import numpy as np
from scipy import signal

import generate_benchmark as gb

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data"
EDF = ROOT / "tools" / "raw" / "S001R02.edf"
SOURCE = "PhysioNet EEG Motor Movement/Imagery Dataset, S001R02"
LICENSE = "Open Data Commons Attribution License v1.0"

CHANNELS = ["Fp1", "Fp2", "Fz", "Cz", "Pz", "Oz", "F3", "F4",
            "C3", "C4", "P3", "P4", "O1", "O2", "T3", "T4"]
SRC_NAMES = {"T3": "T7", "T4": "T8"}


def load_background():
    edf = edfio.read_edf(str(EDF))
    by_name = {s.label.rstrip("."): s for s in edf.signals}
    data = np.stack([by_name[SRC_NAMES.get(ch, ch)].data for ch in CHANNELS])
    data = signal.resample_poly(data, 25, 16, axis=-1)  # 160 -> 250 Hz
    start = 5 * gb.SFREQ
    data = data[:, start:start + gb.N_TIMES]
    data = signal.sosfiltfilt(signal.butter(4, .5, "highpass", fs=gb.SFREQ, output="sos"), data)
    data = (data - data.mean(axis=1, keepdims=True)) / (data.std(axis=1, keepdims=True) + 1e-9) * 10.0
    return data


def add_erp(clean):
    rng = np.random.default_rng(20261106)
    erp = np.zeros_like(clean)
    for ev in gb.EVENTS:
        jitter = int(rng.integers(-5, 6))
        t = (np.arange(gb.N_TIMES) - ev - jitter) / gb.SFREQ
        n400 = -8.0 * rng.uniform(.8, 1.2) * np.exp(-((t - .40) ** 2) / (2 * .06 ** 2))
        p100 = 4.0 * np.exp(-((t - .10) ** 2) / (2 * .025 ** 2))
        erp += gb.weights({"Cz": 1, "Pz": .8, "C3": .7, "C4": .7, "Fz": .4}) * n400[None, :]
        erp += gb.weights({"Oz": 1, "O1": .9, "O2": .9, "Pz": .5}) * p100[None, :]
    return clean + erp


def main():
    gb.SFREQ = 250
    gb.DURATION = 40
    gb.N_TIMES = gb.SFREQ * gb.DURATION
    gb.CHANNELS = CHANNELS
    gb.DISPLAY_CHANNELS = ["Fp1", "Cz", "Oz"]
    gb.EVENTS = np.arange(1, gb.DURATION, 2) * gb.SFREQ
    gb.W_START, gb.W_END = 6 * gb.SFREQ, 10 * gb.SFREQ

    clean = add_erp(load_background())
    psd_freqs = np.round(signal.welch(clean[0], fs=gb.SFREQ, nperseg=1024)[0], 2)
    psd_freqs = psd_freqs[psd_freqs <= 60].tolist()
    erp_times = (np.arange(-50, 200) / gb.SFREQ).round(3).tolist()
    summary = {"dataset": "real", "source": SOURCE, "license": LICENSE,
               "conditions": [], "methods": gb.METHODS, "artifacts": gb.ARTIFACTS,
               "snr_levels": gb.SNR_LEVELS, "channels": CHANNELS}

    for kind in gb.ARTIFACTS:
        for snr in gb.SNR_LEVELS:
            rng = np.random.default_rng(zlib.crc32(f"real_{kind}_{snr}".encode()))
            noisy = clean + gb.scale_to_snr(clean, gb.make_artifact(kind, rng), snr)
            outputs = {"noisy": noisy, "clean": clean,
                       "bandpass": gb.bandpass(noisy), "notch": gb.notch(noisy),
                       "wavelet": gb.wavelet_denoise(noisy), "ica": gb.ica_denoise(noisy, kind),
                       "asr": gb.asr_denoise(noisy)}
            doc = {
                "dataset": "real", "source": SOURCE, "license": LICENSE,
                "background": "真实眼闭静息 EEG（0.5Hz 高通、逐通道归一化）+ 合成 ERP 与伪迹",
                "artifact": kind, "snr": snr, "sfreq": gb.SFREQ,
                "channels": CHANNELS, "display_channels": gb.DISPLAY_CHANNELS,
                "window": [6, 10], "psd_freqs": psd_freqs, "erp_times": erp_times,
                "waveforms": {}, "psd": {}, "erp": {}, "metrics": {},
            }
            for name, arr in outputs.items():
                doc["waveforms"][name] = {
                    ch: np.round(arr[CHANNELS.index(ch), gb.W_START:gb.W_END], 3).tolist()
                    for ch in gb.DISPLAY_CHANNELS
                }
                doc["psd"][name] = np.round(gb.psd_curve(arr, CHANNELS.index("Cz")), 2).tolist()
                doc["erp"][name] = np.round(gb.erp_wave(arr, CHANNELS.index("Cz")), 3).tolist()
                if name != "clean":
                    doc["metrics"][name] = gb.evaluate(arr, clean, noisy)
            path = OUT / f"real_{kind}_{snr}.json"
            path.write_text(json.dumps(doc, separators=(",", ":")), encoding="utf-8")
            summary["conditions"].append({"artifact": kind, "snr": snr,
                                          "file": path.name, "metrics": doc["metrics"]})
            print(f"{path.name}: ica corr={doc['metrics']['ica']['corr']} "
                  f"bandpass corr={doc['metrics']['bandpass']['corr']}", flush=True)
    (OUT / "real_summary.json").write_text(json.dumps(summary, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
