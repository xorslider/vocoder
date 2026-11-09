const MAXIMUM_VOICE_COUNT = 4;
const LOWEST_BAND_FREQUENCY = 120;
const HIGHEST_BAND_FREQUENCY = 7500;
const SIBILANCE_CUTOFF_FREQUENCY = 5500;
const LEVEL_REPORT_INTERVAL_IN_SAMPLES = 2048;
const OUTPUT_MAKEUP_GAIN = 14;

class BiquadSection {
  constructor() {
    this.feedForwardZero = 0;
    this.feedForwardOne = 0;
    this.feedForwardTwo = 0;
    this.feedbackOne = 0;
    this.feedbackTwo = 0;
    this.memoryFirst = 0;
    this.memorySecond = 0;
  }

  configureBandpass(centerFrequency, qualityFactor) {
    const angularFrequency = (2 * Math.PI * centerFrequency) / sampleRate;
    const alpha = Math.sin(angularFrequency) / (2 * qualityFactor);
    const normalization = 1 + alpha;
    this.feedForwardZero = alpha / normalization;
    this.feedForwardOne = 0;
    this.feedForwardTwo = -alpha / normalization;
    this.feedbackOne = (-2 * Math.cos(angularFrequency)) / normalization;
    this.feedbackTwo = (1 - alpha) / normalization;
  }

  configureHighpass(cutoffFrequency, qualityFactor) {
    const angularFrequency = (2 * Math.PI * cutoffFrequency) / sampleRate;
    const cosine = Math.cos(angularFrequency);
    const alpha = Math.sin(angularFrequency) / (2 * qualityFactor);
    const normalization = 1 + alpha;
    this.feedForwardZero = (1 + cosine) / 2 / normalization;
    this.feedForwardOne = -(1 + cosine) / normalization;
    this.feedForwardTwo = this.feedForwardZero;
    this.feedbackOne = (-2 * cosine) / normalization;
    this.feedbackTwo = (1 - alpha) / normalization;
  }

  process(inputSample) {
    const outputSample = this.feedForwardZero * inputSample + this.memoryFirst;
    this.memoryFirst = this.feedForwardOne * inputSample - this.feedbackOne * outputSample + this.memorySecond;
    this.memorySecond = this.feedForwardTwo * inputSample - this.feedbackTwo * outputSample;
    return outputSample;
  }
}

function correctionNearDiscontinuity(phase, phaseIncrement) {
  if (phase < phaseIncrement) {
    const ratio = phase / phaseIncrement;
    return ratio + ratio - ratio * ratio - 1;
  }
  if (phase > 1 - phaseIncrement) {
    const ratio = (phase - 1) / phaseIncrement;
    return ratio * ratio + ratio + ratio + 1;
  }
  return 0;
}

function generateWaveformSample(phase, phaseIncrement, waveformName) {
  if (waveformName === "square") {
    const halfCycleShiftedPhase = (phase + 0.5) % 1;
    return (
      (phase < 0.5 ? 1 : -1) +
      correctionNearDiscontinuity(phase, phaseIncrement) -
      correctionNearDiscontinuity(halfCycleShiftedPhase, phaseIncrement)
    );
  }
  return 2 * phase - 1 - correctionNearDiscontinuity(phase, phaseIncrement);
}

class VocoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();

    this.settings = {
      bandCount: 16,
      sharpness: 1.2,
      releaseMilliseconds: 40,
      inputGain: 4,
      noiseThreshold: 0.2,
      sibilanceAmount: 1,
      waveform: "sawtooth",
      noiseMix: 0.05,
      outputVolume: 1,
      arpeggioEnabled: false,
      tempoBeatsPerMinute: 120,
      noteFrequencies: [],
    };

    this.voicePhases = new Float32Array(MAXIMUM_VOICE_COUNT);
    this.voiceGate = 0;
    this.arpeggioStepIndex = 0;
    this.samplesSinceArpeggioStep = 0;
    this.samplesSinceLevelReport = 0;

    this.rebuildFilters();
    this.updateEnvelopeCoefficients();

    this.port.onmessage = (event) => {
      Object.assign(this.settings, event.data);
      const filtersNeedRebuilding =
        this.settings.bandCount !== this.builtBandCount || this.settings.sharpness !== this.builtSharpness;
      if (filtersNeedRebuilding) {
        this.rebuildFilters();
      }
      this.updateEnvelopeCoefficients();
    };
  }

  rebuildFilters() {
    const bandCount = this.settings.bandCount;
    const frequencyRatio = Math.pow(HIGHEST_BAND_FREQUENCY / LOWEST_BAND_FREQUENCY, 1 / (bandCount - 1));
    const idealQualityFactor = Math.sqrt(frequencyRatio) / (frequencyRatio - 1);
    const qualityFactor = idealQualityFactor * this.settings.sharpness;

    this.bands = [];
    for (let bandIndex = 0; bandIndex < bandCount; bandIndex++) {
      const centerFrequency = LOWEST_BAND_FREQUENCY * Math.pow(frequencyRatio, bandIndex);
      const band = {
        analysisFirstSection: new BiquadSection(),
        analysisSecondSection: new BiquadSection(),
        synthesisFirstSection: new BiquadSection(),
        synthesisSecondSection: new BiquadSection(),
        envelope: 0,
      };
      band.analysisFirstSection.configureBandpass(centerFrequency, qualityFactor);
      band.analysisSecondSection.configureBandpass(centerFrequency, qualityFactor);
      band.synthesisFirstSection.configureBandpass(centerFrequency, qualityFactor);
      band.synthesisSecondSection.configureBandpass(centerFrequency, qualityFactor);
      this.bands.push(band);
    }

    this.sibilanceAnalysisFilter = new BiquadSection();
    this.sibilanceAnalysisFilter.configureHighpass(SIBILANCE_CUTOFF_FREQUENCY, 0.707);
    this.sibilanceNoiseFilter = new BiquadSection();
    this.sibilanceNoiseFilter.configureHighpass(SIBILANCE_CUTOFF_FREQUENCY - 500, 0.707);
    this.sibilanceEnvelope = 0;

    this.builtBandCount = bandCount;
    this.builtSharpness = this.settings.sharpness;
  }

  updateEnvelopeCoefficients() {
    const releaseSeconds = this.settings.releaseMilliseconds / 1000;
    const attackSeconds = Math.max(0.002, releaseSeconds / 4);
    this.attackCoefficient = Math.exp(-1 / (attackSeconds * sampleRate));
    this.releaseCoefficient = Math.exp(-1 / (releaseSeconds * sampleRate));
  }

  selectActiveFrequencies(blockLength) {
    const noteFrequencies = this.settings.noteFrequencies;
    if (!this.settings.arpeggioEnabled || noteFrequencies.length === 0) {
      return noteFrequencies.slice(0, MAXIMUM_VOICE_COUNT);
    }

    const arpeggioPattern = noteFrequencies.concat(noteFrequencies.map((noteFrequency) => noteFrequency * 2));
    const stepDurationInSamples = (sampleRate * 60) / (this.settings.tempoBeatsPerMinute * 4);
    this.samplesSinceArpeggioStep += blockLength;
    if (this.samplesSinceArpeggioStep >= stepDurationInSamples) {
      this.samplesSinceArpeggioStep -= stepDurationInSamples;
      this.arpeggioStepIndex += 1;
    }
    return [arpeggioPattern[this.arpeggioStepIndex % arpeggioPattern.length]];
  }

  process(inputs, outputs) {
    const outputChannel = outputs[0][0];
    const inputChannel = inputs[0] ? inputs[0][0] : undefined;
    const blockLength = outputChannel.length;

    const activeFrequencies = this.selectActiveFrequencies(blockLength);
    const voiceGateTarget = activeFrequencies.length > 0 ? 1 : 0;
    const voiceCountNormalization = 1 / Math.sqrt(Math.max(1, activeFrequencies.length));

    const { inputGain, waveform, noiseMix, outputVolume, sibilanceAmount } = this.settings;
    const noiseThreshold = this.settings.noiseThreshold * this.settings.noiseThreshold * 0.05;

    for (let sampleIndex = 0; sampleIndex < blockLength; sampleIndex++) {
      const modulatorSample = inputChannel ? inputChannel[sampleIndex] * inputGain : 0;

      this.voiceGate += (voiceGateTarget - this.voiceGate) * 0.003;
      let tonalSample = 0;
      for (let voiceIndex = 0; voiceIndex < activeFrequencies.length; voiceIndex++) {
        const phaseIncrement = activeFrequencies[voiceIndex] / sampleRate;
        const phase = this.voicePhases[voiceIndex];
        tonalSample += generateWaveformSample(phase, phaseIncrement, waveform);
        this.voicePhases[voiceIndex] = (phase + phaseIncrement) % 1;
      }
      const whiteNoiseSample = Math.random() * 2 - 1;
      const carrierSample =
        tonalSample * voiceCountNormalization * this.voiceGate * (1 - noiseMix) + whiteNoiseSample * noiseMix * 0.5;

      let mixedSample = 0;
      for (let bandIndex = 0; bandIndex < this.bands.length; bandIndex++) {
        const band = this.bands[bandIndex];

        const analysedSample = band.analysisSecondSection.process(band.analysisFirstSection.process(modulatorSample));
        const rectifiedSample = Math.abs(analysedSample);
        const smoothingCoefficient = rectifiedSample > band.envelope ? this.attackCoefficient : this.releaseCoefficient;
        band.envelope = rectifiedSample + smoothingCoefficient * (band.envelope - rectifiedSample);

        const gatedEnvelope = Math.max(0, band.envelope - noiseThreshold);
        const filteredCarrier = band.synthesisSecondSection.process(band.synthesisFirstSection.process(carrierSample));
        mixedSample += filteredCarrier * gatedEnvelope;
      }

      const sibilanceSample = Math.abs(this.sibilanceAnalysisFilter.process(modulatorSample));
      const sibilanceCoefficient = sibilanceSample > this.sibilanceEnvelope ? this.attackCoefficient : this.releaseCoefficient;
      this.sibilanceEnvelope = sibilanceSample + sibilanceCoefficient * (this.sibilanceEnvelope - sibilanceSample);
      const gatedSibilance = Math.max(0, this.sibilanceEnvelope - noiseThreshold);
      const sibilanceOutput = this.sibilanceNoiseFilter.process(whiteNoiseSample) * gatedSibilance * sibilanceAmount * 6;

      outputChannel[sampleIndex] = Math.tanh((mixedSample * OUTPUT_MAKEUP_GAIN + sibilanceOutput) * outputVolume);
    }

    this.samplesSinceLevelReport += blockLength;
    if (this.samplesSinceLevelReport >= LEVEL_REPORT_INTERVAL_IN_SAMPLES) {
      this.samplesSinceLevelReport = 0;
      this.port.postMessage({ bandLevels: this.bands.map((band) => band.envelope) });
    }

    return true;
  }
}

registerProcessor("vocoder-processor", VocoderProcessor);
