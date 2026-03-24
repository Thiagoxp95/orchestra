#!/usr/bin/env ruby

require 'base64'
require 'digest'
require 'optparse'
require 'yaml'

options = {}

OptionParser.new do |opts|
  opts.banner = 'Usage: verify-latest-mac.rb --yaml latest-mac.yml --asset path/to/asset.zip [--url Orchestra-0.6.6-mac-arm64.zip]'

  opts.on('--yaml PATH', 'Path to latest-mac.yml') { |value| options[:yaml] = value }
  opts.on('--asset PATH', 'Path to the downloaded asset file') { |value| options[:asset] = value }
  opts.on('--url URL', 'Asset URL entry inside latest-mac.yml to validate (defaults to path)') { |value| options[:url] = value }
end.parse!

abort('Missing --yaml') unless options[:yaml]
abort('Missing --asset') unless options[:asset]

metadata = YAML.safe_load(File.read(options[:yaml]), aliases: true)
abort("Invalid YAML in #{options[:yaml]}") unless metadata.is_a?(Hash)

target_url = options[:url] || metadata['path']
abort("Could not determine target asset URL from #{options[:yaml]}") if target_url.to_s.empty?

files = Array(metadata['files'])
entry = files.find { |item| item.is_a?(Hash) && item['url'].to_s == target_url.to_s }
entry ||= {
  'url' => metadata['path'],
  'sha512' => metadata['sha512'],
  'size' => metadata['size'],
}

abort("No metadata entry found for #{target_url}") if entry['url'].to_s.empty?

asset_bytes = File.binread(options[:asset])
actual_size = asset_bytes.bytesize
actual_sha512 = Digest::SHA512.base64digest(asset_bytes)

errors = []
if entry['size'] && entry['size'].to_i != actual_size
  errors << "size mismatch for #{entry['url']}: expected #{entry['size']}, got #{actual_size}"
end

if entry['sha512'] && entry['sha512'] != actual_sha512
  errors << "sha512 mismatch for #{entry['url']}: expected #{entry['sha512']}, got #{actual_sha512}"
end

if errors.empty?
  puts "verified #{entry['url']}"
  exit 0
end

warn errors.join("\n")
exit 1
