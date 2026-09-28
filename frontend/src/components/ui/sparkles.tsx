"use client";

import React, { useCallback, useId, useMemo } from "react";
import Particles, { ParticlesProvider } from "@tsparticles/react";
import type { Container, Engine, ISourceOptions } from "@tsparticles/engine";
import { loadSlim } from "@tsparticles/slim";
import { motion, useAnimation } from "motion/react";

import { cn } from "@/lib/utils";

type ParticlesProps = {
  id?: string;
  className?: string;
  background?: string;
  minSize?: number;
  maxSize?: number;
  speed?: number;
  particleColor?: string;
  particleDensity?: number;
};

const initializeParticles = async (engine: Engine) => {
  await loadSlim(engine);
};

export const SparklesCore = ({
  id,
  className,
  background = "transparent",
  minSize = 0.4,
  maxSize = 1,
  speed = 1,
  particleColor = "#ffffff",
  particleDensity = 120,
}: ParticlesProps) => {
  const controls = useAnimation();
  const generatedId = useId();
  const particlesLoaded = useCallback(async (container?: Container) => {
    if (!container) return;
    await controls.start({ opacity: 1, transition: { duration: 0.6 } });
  }, [controls]);
  const options = useMemo<ISourceOptions>(() => ({
    background: { color: { value: background } },
    fullScreen: { enable: false, zIndex: 1 },
    fpsLimit: 60,
    interactivity: {
      events: {
        onClick: { enable: false, mode: "push" },
        onHover: { enable: false, mode: "repulse" },
      },
    },
    particles: {
      color: { value: particleColor },
      move: {
        direction: "none",
        enable: true,
        outModes: { default: "out" },
        random: true,
        speed: { min: 0.08, max: 0.55 },
        straight: false,
      },
      number: {
        density: { enable: true, width: 400, height: 400 },
        value: particleDensity,
      },
      opacity: {
        value: { min: 0.15, max: 0.9 },
        animation: { enable: true, speed, sync: false },
      },
      shape: { type: "circle" },
      size: { value: { min: minSize, max: maxSize } },
    },
    detectRetina: true,
  }), [background, maxSize, minSize, particleColor, particleDensity, speed]);

  return (
    <ParticlesProvider init={initializeParticles}>
      <motion.div animate={controls} className={cn("h-full w-full opacity-0", className)}>
        <Particles
          id={id || generatedId}
          className="h-full w-full"
          particlesLoaded={particlesLoaded}
          options={options}
        />
      </motion.div>
    </ParticlesProvider>
  );
};
