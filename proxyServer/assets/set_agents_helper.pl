# IETI Agents setup helper (Perl)
#
# set_agents_opencode.sh does its work through a helper. The helper exists twice, in Python
# inside that script and in Perl here, and both do exactly the same. This one runs on
# machines without a working Python 3, which is every Mac without Apple's developer tools.
# It needs only what ships with Perl 5.16 or newer, plus curl for the one request to the
# server. Keep it in step with the Python helper: test/set-agents.test.js runs the same
# scenarios through both and compares what they write, byte for byte.
BEGIN { @INC = grep { !ref($_) && $_ ne '.' } @INC }
use strict;
use warnings;
use Cwd ();
use Encode ();
use Fcntl qw(:DEFAULT :mode);
use IPC::Open2 ();
use MIME::Base64 ();
use POSIX ();

# ---- Errors: fail() carries a message for the user; everything else is unexpected.
sub fail { die { message => $_[0] } }
sub os_fail { my ($path) = @_; fail("$!: $path") }

# ---- JSON values. Objects keep the order of their keys and numbers keep their type, so a
# configuration is written back as it was read. Strings are plain scalars, arrays are array
# references, null is undef.
{ package IETI::Object; package IETI::Number; package IETI::Bool; }
my $TRUE = bless \(my $true = 1), 'IETI::Bool';
my $FALSE = bless \(my $false = 0), 'IETI::Bool';
sub boolean { $_[0] ? $TRUE : $FALSE }
sub number { my ($text) = @_; bless \$text, 'IETI::Number' }
sub is_obj { ref($_[0]) eq 'IETI::Object' }
sub is_arr { ref($_[0]) eq 'ARRAY' }
sub is_num { ref($_[0]) eq 'IETI::Number' }
sub is_bool { ref($_[0]) eq 'IETI::Bool' }
sub is_str { defined($_[0]) && !ref($_[0]) }
sub is_true { is_bool($_[0]) && ${ $_[0] } }
sub obj { my $object = bless { keys => [], values => {} }, 'IETI::Object'; while (@_) { my $key = shift; obj_set($object, $key, shift) } $object }
sub obj_has { exists $_[0]{values}{ $_[1] } }
sub obj_get { $_[0]{values}{ $_[1] } }
sub obj_keys { @{ $_[0]{keys} } }
sub obj_set { my ($object, $key, $value) = @_; push @{ $object->{keys} }, $key unless exists $object->{values}{$key}; $object->{values}{$key} = $value }
sub obj_del { my ($object, $key) = @_; return undef unless exists $object->{values}{$key}; @{ $object->{keys} } = grep { $_ ne $key } @{ $object->{keys} }; delete $object->{values}{$key} }
# get() of a key from a value that may not be an object at all
sub field { is_obj($_[0]) ? obj_get($_[0], $_[1]) : undef }
# Empty strings, zero, false, null and empty containers count as "not set".
sub truthy {
    my ($value) = @_;
    return 0 unless defined $value;
    return ${$value} ? 1 : 0 if is_bool($value);
    return ${$value} + 0 != 0 ? 1 : 0 if is_num($value);
    return scalar(@$value) ? 1 : 0 if is_arr($value);
    return scalar(obj_keys($value)) ? 1 : 0 if is_obj($value);
    return length($value) ? 1 : 0;
}
sub starts_with { is_str($_[0]) && index($_[0], $_[1]) == 0 }

sub float_text {
    # The shortest text that reads back as the same number, written the way JSON tools write it.
    my ($value) = @_;
    my $digits;
    for my $precision (1 .. 17) { $digits = sprintf('%.*e', $precision - 1, $value); last if $digits + 0 == $value }
    my ($mantissa, $exponent) = $digits =~ /^(-?[\d.]+)e([+-]\d+)$/;
    $exponent += 0;
    (my $plain = $mantissa) =~ s/[-.]//g;
    my $sign = $mantissa =~ /\A-/ ? '-' : '';
    if ($exponent < -4 || $exponent >= 16) {
        my $rest = substr($plain, 1);
        return $sign . substr($plain, 0, 1) . (length($rest) ? ".$rest" : '') . sprintf('e%s%02d', $exponent < 0 ? '-' : '+', abs($exponent));
    }
    return $sign . '0.' . ('0' x (-$exponent - 1)) . $plain if $exponent < 0;
    $plain .= '0' x ($exponent + 1 - length($plain)) if length($plain) < $exponent + 1;
    my $fraction = substr($plain, $exponent + 1);
    return $sign . substr($plain, 0, $exponent + 1) . '.' . (length($fraction) ? $fraction : '0');
}

sub json_error { my ($text, $position, $what) = @_;
    my $before = substr($$text, 0, $position);
    my $line = 1 + ($before =~ tr/\n//);
    my $column = $position - (rindex($before, "\n") + 1) + 1;
    fail("$what: line $line column $column (char $position)");
}
sub json_value {
    my ($text) = @_;
    $$text =~ /\G[ \t\n\r]+/gc;
    my $start = pos($$text) || 0;
    if ($$text =~ /\G\{/gc) {
        my $object = obj();
        $$text =~ /\G[ \t\n\r]+/gc;
        return $object if $$text =~ /\G\}/gc;
        while (1) {
            $$text =~ /\G[ \t\n\r]+/gc;
            json_error($text, pos($$text) || 0, 'Expecting property name enclosed in double quotes') unless substr($$text, pos($$text) || 0, 1) eq '"';
            my $key = json_string($text);
            $$text =~ /\G[ \t\n\r]+/gc;
            json_error($text, pos($$text) || 0, "Expecting ':' delimiter") unless $$text =~ /\G:/gc;
            obj_set($object, $key, json_value($text));
            $$text =~ /\G[ \t\n\r]+/gc;
            next if $$text =~ /\G,/gc;
            return $object if $$text =~ /\G\}/gc;
            json_error($text, pos($$text) || 0, "Expecting ',' delimiter");
        }
    }
    if ($$text =~ /\G\[/gc) {
        my @items;
        $$text =~ /\G[ \t\n\r]+/gc;
        return \@items if $$text =~ /\G\]/gc;
        while (1) {
            push @items, json_value($text);
            $$text =~ /\G[ \t\n\r]+/gc;
            next if $$text =~ /\G,/gc;
            return \@items if $$text =~ /\G\]/gc;
            json_error($text, pos($$text) || 0, "Expecting ',' delimiter");
        }
    }
    return json_string($text) if substr($$text, $start, 1) eq '"';
    return $TRUE if $$text =~ /\Gtrue/gc;
    return $FALSE if $$text =~ /\Gfalse/gc;
    return undef if $$text =~ /\Gnull/gc;
    fail("Invalid JSON constant: $1") if $$text =~ /\G(NaN|-?Infinity)/gc;
    if ($$text =~ /\G(-?(?:0|[1-9][0-9]*))((?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/gc) {
        my ($integer, $rest) = ($1, $2);
        return number($integer eq '-0' ? '0' : $integer) unless length $rest;
        my $value = ($integer . $rest) + 0;
        fail("Invalid JSON number: $integer$rest") if $value != $value || $value == 9**9**9 || $value == -9**9**9;
        return number('-0.0') if $value == 0 && $integer =~ /\A-/;
        return number(float_text($value));
    }
    json_error($text, $start, 'Expecting value');
}
sub json_string {
    my ($text) = @_;
    my $start = pos($$text) || 0;
    $$text =~ /\G"/gc;
    my $result = '';
    while (1) {
        $result .= $1 if $$text =~ /\G([^"\\\x00-\x1f]+)/gc;
        return $result if $$text =~ /\G"/gc;
        if ($$text =~ /\G\\/gc) {
            if ($$text =~ /\G(["\\\/bfnrt])/gc) { $result .= { '"' => '"', '\\' => '\\', '/' => '/', b => "\b", f => "\f", n => "\n", r => "\r", t => "\t" }->{$1}; next }
            if ($$text =~ /\Gu([0-9a-fA-F]{4})/gc) {
                my $code = hex $1;
                if ($code >= 0xD800 && $code <= 0xDBFF && $$text =~ /\G\\u([dD][c-fC-F][0-9a-fA-F]{2})/gc) {
                    $code = 0x10000 + (($code - 0xD800) << 10) + (hex($1) - 0xDC00);
                }
                $result .= chr $code;
                next;
            }
            json_error($text, (pos($$text) || 0) - 1, 'Invalid \\escape');
        }
        json_error($text, pos($$text) || 0, 'Invalid control character at') if substr($$text, pos($$text) || 0, 1) =~ /\A[\x00-\x1f]\z/;
        json_error($text, $start, 'Unterminated string starting at');
    }
}
sub load_json {
    my ($source) = @_;
    pos($source) = 0;
    my $value = json_value(\$source);
    $source =~ /\G[ \t\n\r]+/gc;
    json_error(\$source, pos($source) || 0, 'Extra data') if (pos($source) || 0) < length $source;
    return $value;
}
sub json_text {
    my ($string) = @_;
    my %short = ('"' => '\\"', '\\' => '\\\\', "\n" => '\\n', "\r" => '\\r', "\t" => '\\t', "\b" => '\\b', "\f" => '\\f');
    $string =~ s{(["\\]|[^\x20-\x7e])}{
        my $character = $1; my $code = ord $character;
        exists $short{$character} ? $short{$character}
            : $code > 0xFFFF ? sprintf('\\u%04x\\u%04x', 0xD800 + (($code - 0x10000) >> 10), 0xDC00 + (($code - 0x10000) & 0x3FF))
            : sprintf('\\u%04x', $code)
    }ge;
    return "\"$string\"";
}
# Without $indent: compact, one line. With it: one item per line, as configuration files are kept.
sub dump_json {
    my ($value, $indent, $level) = @_;
    $level ||= 0;
    return 'null' unless defined $value;
    return ${$value} ? 'true' : 'false' if is_bool($value);
    return ${$value} if is_num($value);
    return json_text($value) unless ref $value;
    my ($open, $close, @items) = is_obj($value)
        ? ('{', '}', map { json_text($_) . ': ' . dump_json(obj_get($value, $_), $indent, $level + 1) } obj_keys($value))
        : ('[', ']', map { dump_json($_, $indent, $level + 1) } @$value);
    return $open . $close unless @items;
    return $open . join(', ', @items) . $close unless defined $indent;
    my $inner = "\n" . (' ' x ($indent * ($level + 1)));
    return $open . $inner . join(",$inner", @items) . "\n" . (' ' x ($indent * $level)) . $close;
}

# ---- Text and files
sub decode_utf8 {
    my ($bytes) = @_;
    my $text = eval { Encode::decode('UTF-8', my $copy = $bytes, Encode::FB_CROAK) };
    fail('The file is not valid UTF-8 text.') unless defined $text;
    return $text;
}
sub parse_jsonc {
    my ($source) = @_;
    $source =~ s/^\x{FEFF}+//;
    my @characters = split //, $source;
    my ($clean, $quoted, $escaped, $index) = ('', 0, 0, 0);
    while ($index < @characters) {
        my $character = $characters[$index];
        my $pair = $character . ($index + 1 < @characters ? $characters[ $index + 1 ] : '');
        if ($quoted) {
            $clean .= $character;
            if ($escaped) { $escaped = 0 } elsif ($character eq '\\') { $escaped = 1 } elsif ($character eq '"') { $quoted = 0 }
        } elsif ($character eq '"') {
            $quoted = 1; $clean .= $character;
        } elsif ($pair eq '//') {
            $clean .= '  '; $index += 2;
            while ($index < @characters && $characters[$index] !~ /[\r\n]/) { $clean .= ' '; $index++ }
            $clean .= $characters[$index] if $index < @characters;
        } elsif ($pair eq '/*') {
            $clean .= '  '; $index += 2;
            while ($index < @characters && !($characters[$index] eq '*' && $index + 1 < @characters && $characters[ $index + 1 ] eq '/')) {
                $clean .= $characters[$index] =~ /[\r\n]/ ? $characters[$index] : ' '; $index++;
            }
            fail('Unterminated JSON comment.') if $index >= @characters;
            $clean .= '  '; $index++;
        } else {
            $clean .= $character;
        }
        $index++;
    }
    @characters = split //, $clean;
    my $result = '';
    ($quoted, $escaped) = (0, 0);
    for my $position (0 .. $#characters) {
        my $character = $characters[$position];
        if ($quoted) {
            $result .= $character;
            if ($escaped) { $escaped = 0 } elsif ($character eq '\\') { $escaped = 1 } elsif ($character eq '"') { $quoted = 0 }
        } elsif ($character eq '"') {
            $quoted = 1; $result .= $character;
        } elsif ($character eq ',') {
            my $next = $position + 1;
            $next++ while $next < @characters && $characters[$next] =~ /\s/;
            $result .= $character if $next >= @characters || $characters[$next] !~ /[}\]]/;
        } else {
            $result .= $character;
        }
    }
    return load_json($result);
}
sub read_bytes {
    my ($path) = @_;
    sysopen(my $handle, $path, O_RDONLY) or os_fail($path);
    binmode $handle;
    my ($contents, $chunk) = ('');
    while (1) { my $read = sysread($handle, $chunk, 1 << 20); os_fail($path) unless defined $read; last unless $read; $contents .= $chunk }
    close $handle;
    return $contents;
}
sub snapshot {
    my ($destination) = @_;
    my $handle;
    unless (sysopen($handle, $destination, O_RDONLY)) {
        return obj(exists => $FALSE) if $!{ENOENT};
        os_fail($destination);
    }
    my @information = stat $handle;
    fail("Expected a file at $destination.") unless S_ISREG($information[2]);
    close $handle;
    return obj(exists => $TRUE, contents => MIME::Base64::encode_base64(read_bytes($destination), ''), mode => number(S_IMODE($information[2])));
}
sub exists_in { is_true(obj_get($_[0], 'exists')) }
sub same {
    my ($left, $right) = @_;
    return exists_in($left) == exists_in($right) && (!exists_in($left) || obj_get($left, 'contents') eq obj_get($right, 'contents'));
}
sub original_bytes { MIME::Base64::decode_base64(obj_get($_[0], 'contents')) }
sub read_config {
    my ($config_path, $original) = @_;
    $original ||= snapshot($config_path);
    return obj() unless exists_in($original);
    my $config = eval {
        my $parsed = parse_jsonc(decode_utf8(original_bytes($original)));
        fail('Expected a JSON object.') unless is_obj($parsed);
        $parsed;
    };
    return $config if $config;
    fail("Cannot update $config_path: " . (ref($@) eq 'HASH' ? $@->{message} : $@));
}
sub write_private {
    my ($destination, $contents) = @_;
    sysopen(my $handle, $destination, O_WRONLY | O_CREAT | O_TRUNC, 0600) or os_fail($destination);
    chmod(0600, $handle) or os_fail($destination);
    binmode $handle;
    my $offset = 0;
    while ($offset < length $contents) {
        my $written = syswrite($handle, $contents, length($contents) - $offset, $offset);
        os_fail($destination) unless defined $written;
        $offset += $written;
    }
    close($handle) or os_fail($destination);
}
sub write_json { write_private($_[0], Encode::encode('UTF-8', dump_json($_[1]) . "\n")) }
sub read_json { my $text = decode_utf8(read_bytes($_[0])); $text =~ s/^\x{FEFF}//; load_json($text) }
sub random_hex {
    my $bytes = '';
    if (open(my $random, '<', '/dev/urandom')) { binmode $random; read($random, $bytes, 16); close $random }
    $bytes .= chr(int(rand(256))) while length($bytes) < 16;
    return unpack('H*', $bytes);
}
sub temporary {
    my ($destination) = @_;
    my $filename = "$destination.tmp." . random_hex();
    sysopen(my $handle, $filename, O_WRONLY | O_CREAT | O_EXCL, 0600) or os_fail($filename);
    close $handle;
    return $filename;
}
sub remove { my ($filename) = @_; return unless defined $filename && length $filename; unlink($filename) or $!{ENOENT} or os_fail($filename) }
sub replace { rename($_[0], $_[1]) or os_fail($_[1]) }
sub restore {
    my ($destination, $original) = @_;
    return remove($destination) unless exists_in($original);
    my $filename = temporary($destination);
    my $done = eval {
        write_private($filename, original_bytes($original));
        chmod(${ obj_get($original, 'mode') }, $filename) or os_fail($filename);
        replace($filename, $destination);
        1;
    };
    my $error = $@;
    remove($filename);
    die $error unless $done;
}
sub dirname { my ($path) = @_; my $slash = rindex($path, '/'); return '' if $slash < 0; my $head = substr($path, 0, $slash + 1); $head =~ s{/+\z}{} unless $head =~ m{\A/+\z}; $head }
sub basename { my ($path) = @_; substr($path, rindex($path, '/') + 1) }
sub absolute {
    my ($path) = @_;
    $path = Cwd::getcwd() . "/$path" unless $path =~ m{\A/};
    my @parts;
    for my $part (split m{/+}, $path) {
        next if $part eq '' || $part eq '.';
        if ($part eq '..') { pop @parts } else { push @parts, $part }
    }
    return ($path =~ m{\A//(?!/)} ? '//' : '/') . join('/', @parts);
}

# ---- The model catalog the server publishes, as OpenCode model entries
sub positive_number {
    my ($value) = @_;
    my $text = is_num($value) ? ${$value} : is_str($value) ? $value : fail('Invalid model limit.');
    $text =~ s/\A\s+|\s+\z//g;
    fail('Invalid model limit.') unless $text =~ /\A[+-]?(?:[0-9]+(?:_[0-9]+)*\.?(?:[0-9]+(?:_[0-9]+)*)?|\.[0-9]+(?:_[0-9]+)*)(?:[eE][+-]?[0-9]+(?:_[0-9]+)*)?\z/;
    $text =~ tr/_//d;
    my $number = $text + 0;
    fail('Invalid model limit.') if $number != $number || $number == 9**9**9 || $number <= 0;
    return $number;
}
sub whole { my ($number) = @_; sprintf('%.0f', POSIX::floor($number)) }
sub limit_number { my ($number) = @_; number($number == POSIX::floor($number) ? whole($number) : float_text($number)) }
sub models_from_catalog {
    my ($catalog_path, $major) = @_;
    my $catalog = eval { read_json($catalog_path) };
    fail('The server returned an invalid model catalog.') if $@ && ref($@) eq 'HASH';
    die $@ if $@;
    my $version = field($catalog, 'schema_version');
    my $data = field($catalog, 'data');
    fail('The authenticated server returned no available models.')
        unless is_obj($catalog) && is_str(obj_get($catalog, 'object')) && obj_get($catalog, 'object') eq 'ieti.model_capabilities.list'
        && is_num($version) && ${$version} eq '1' && is_arr($data) && @$data;
    my @efforts = qw(none minimal low medium high xhigh max);
    my $models = obj();
    for my $published (@$data) {
        fail('Model metadata is incomplete.') unless is_obj($published);
        my $model_id = obj_has($published, 'id') ? obj_get($published, 'id') : '';
        $model_id = is_str($model_id) ? $model_id : '';
        $model_id =~ s/\A\s+|\s+\z//g;
        my ($context, $output) = eval { (positive_number(obj_get($published, 'context_window')), positive_number(obj_get($published, 'max_output_tokens'))) };
        fail('Model metadata is incomplete or duplicated for ' . (length($model_id) ? $model_id : '<unknown model>') . '.')
            if $@ || !length($model_id) || obj_has($models, $model_id);
        my $capabilities = obj_get($published, 'capabilities');
        fail("Model capabilities are incomplete for $model_id.")
            if !is_obj($capabilities) || grep { !is_bool(obj_get($capabilities, $_)) } qw(text image tools reasoning parallel_tools);
        my %can = map { $_ => is_true(obj_get($capabilities, $_)) } qw(text image tools reasoning);
        my $modalities = obj_get($published, 'modalities');
        my @inputs;
        if (is_obj($modalities) && is_arr(obj_get($modalities, 'input'))) {
            @inputs = grep { my $value = $_; is_str($value) && grep { $_ eq $value } qw(text audio image video pdf) } @{ obj_get($modalities, 'input') };
        } else {
            @inputs = (($can{text} ? 'text' : ()), ($can{image} ? 'image' : ()));
        }
        my $published_efforts = obj_get($published, 'reasoning_efforts');
        my @offered = is_arr($published_efforts) ? grep { is_str($_) } @$published_efforts : ();
        my @supported = grep { my $effort = $_; $can{reasoning} && grep { $_ eq $effort } @offered } @efforts;
        my $default_effort = obj_get($published, 'default_reasoning_effort');
        my $default_supported = is_str($default_effort) && grep { $_ eq $default_effort } @supported;
        my $model;
        if ($major >= 2) {
            # OpenCode 2 lists exactly these variants. Its capabilities.reasoning.effort
            # list is not used because some 2.x releases keep only low, medium and high.
            $model = obj(limit => obj(context => number(whole($context)), output => number(whole($output))),
                capabilities => obj(tools => boolean($can{tools}), input => [@inputs], output => ['text'], reasoning => obj(supported => boolean($can{reasoning}))));
            if ($can{reasoning}) {
                obj_set($model, compatibility => obj(reasoningField => 'reasoning_content'));
                obj_set($model, variants => [ map { obj(id => $_, settings => obj(reasoningEffort => $_)) } @supported ]);
            }
            obj_set($model, settings => obj(reasoningEffort => $default_effort)) if $default_supported;
        } else {
            my $variants = obj();
            if ($can{reasoning}) {
                for my $effort (@efforts) {
                    obj_set($variants, $effort, (grep { $_ eq $effort } @supported) ? obj(reasoningEffort => $effort) : obj(disabled => $TRUE));
                }
            }
            $model = obj(limit => obj(context => limit_number($context), output => limit_number($output)), tool_call => boolean($can{tools}), reasoning => boolean($can{reasoning}));
            obj_set($model, interleaved => obj(field => 'reasoning_content')) if $can{reasoning};
            obj_set($model, modalities => obj(input => [@inputs], output => ['text']));
            obj_set($model, variants => $variants);
            obj_set($model, options => obj(reasoningEffort => $default_effort)) if $default_supported;
        }
        obj_set($models, $model_id, $model);
    }
    return $models;
}

# ---- The server address and the request that checks the key
sub normalize_url {
    my ($value) = @_;
    my $invalid = 'Base URL must be HTTP(S), without credentials, query, or fragment.';
    $value =~ s/\A\s+|\s+\z//g;
    $value =~ tr/\t\r\n//d;
    my ($scheme, $rest) = $value =~ m{\A([A-Za-z][A-Za-z0-9+.\-]*):(.*)\z}s ? (lc $1, $2) : ('', $value);
    fail($invalid) unless $scheme eq 'http' || $scheme eq 'https';
    my ($location, $path) = $rest =~ m{\A//([^/?#]*)(.*)\z}s ? ($1, $2) : ('', $rest);
    fail($invalid) if $path =~ /#./s || $path =~ /\?[^#]/s;
    $path =~ s/[?#].*\z//s;
    fail($invalid) if $location =~ /\@/;
    my ($hostname, $port);
    if ($location =~ /\A\[([^\]]*)\](?::(.*))?\z/s) { ($hostname, $port) = ($1, $2) }
    elsif ($location =~ /\A([^:]*)(?::(.*))?\z/s) { ($hostname, $port) = ($1, $2) }
    else { fail($invalid) }
    fail($invalid) unless length $hostname;
    fail('Base URL host names must be written with plain letters, digits, hyphens and dots.') if $hostname =~ /[^\x21-\x7e]/;
    if (index($hostname, ':') < 0) {
        my @labels = split /\./, $hostname, -1;
        pop @labels if @labels > 1 && $labels[-1] eq '';
        fail('Base URL host name is not valid.') if grep { !length($_) || length($_) > 63 } @labels;
    }
    $hostname = lc $hostname;
    if (defined $port && length $port) {
        fail("Port could not be cast to integer value as '$port'") unless $port =~ /\A[0-9]+\z/;
        fail('Port out of range 0-65535') if $port > 65535;
        $port += 0;
    } else { undef $port }
    my $netloc = index($hostname, ':') >= 0 ? "[$hostname]" : $hostname;
    $netloc .= ":$port" if defined $port && $port != ($scheme eq 'https' ? 443 : 80);
    $path =~ s{/+\z}{};
    $path .= '/v1' unless $path =~ m{/v1\z};
    $path = Encode::encode('UTF-8', $path);
    $path =~ s{([^A-Za-z0-9_.\-~/%:\@!\$&'()*+,;=])}{sprintf('%%%02X', ord $1)}ge;
    return "$scheme://$netloc$path";
}
sub which {
    my ($name) = @_;
    for my $folder (split /:/, defined $ENV{PATH} ? $ENV{PATH} : '') {
        my $candidate = (length($folder) ? $folder : '.') . "/$name";
        return $candidate if -f $candidate && -x $candidate;
    }
    return undef;
}
sub read_key { my $key = decode_utf8(read_bytes($_[0])); $key =~ s/^\x{FEFF}//; $key =~ s/\A\s+|\s+\z//g; $key }
sub fetch {
    my ($base_url, $key_path, $output_path, $timeout_seconds) = @_;
    my $key = read_key($key_path);
    my $unreachable = 'Could not connect to the IETI server, or the request timed out. Existing configuration was kept.';
    my $curl = which('curl') or fail('curl was not found. It is needed to reach the IETI server when Python 3 is not installed.');
    my $status = eval {
        fail($unreachable) if $key =~ /[\x00-\x1f\x7f]/ || "$base_url$output_path" =~ /[\x00-\x1f]/;
        write_private($output_path, '');
        my $quoted = sub { my ($text) = @_; $text =~ s/(["\\])/\\$1/g; "\"$text\"" };
        my $timeout = $timeout_seconds + 0;
        # The options, the key among them, go through curl's standard input: they must not
        # appear in the list of running commands. -q keeps a personal .curlrc out of it.
        my $options = join("\n",
            'url = ' . $quoted->("$base_url/model-capabilities"),
            'header = ' . $quoted->("Authorization: Bearer $key"),
            'header = "Accept: application/json"',
            'output = ' . $quoted->($output_path),
            'write-out = "%{http_code}"',
            'max-time = ' . $timeout,
            'connect-timeout = ' . ($timeout < 10 ? $timeout : 10),
            'max-filesize = 16777216',
            'proto = "=http,https"',
            'noproxy = "*"',
            'silent', 'globoff', '') ;
        local $SIG{PIPE} = 'IGNORE';
        my $process = IPC::Open2::open2(my $from_curl, my $to_curl, $curl, '-q', '--config', '-');
        print {$to_curl} Encode::encode('UTF-8', $options);
        close $to_curl;
        my $written = do { local $/; <$from_curl> };
        close $from_curl;
        waitpid $process, 0;
        fail($unreachable) if $? != 0 || !defined $written || $written !~ /\A[1-5][0-9][0-9]\z/;
        fail($unreachable) if -s $output_path > 16 * 1024 * 1024;
        $written;
    };
    fail($unreachable) unless defined $status;
    print $status;
}

# ---- Which OpenCode is installed. It is never run: its version is read from files it leaves behind.
sub version_major { my ($text) = @_; return unless is_str($text) && $text =~ /(([0-9]+)\.[0-9]+\.[0-9]+)/; return ($2 + 0, $1) }
sub read_object { my ($path) = @_; my $value = eval { load_json(decode_utf8(read_bytes($path))) }; return is_obj($value) ? $value : undef }
sub package_version {
    # Reads the version of an npm or Homebrew OpenCode install without running it.
    my ($command) = @_;
    my $real = Cwd::realpath($command);
    $real = $command unless defined $real;
    return $1 if $real =~ m{[\\/]Cellar[\\/]opencode[\\/]([0-9]+\.[0-9]+\.[0-9]+)};
    my $here = dirname($command);
    my @candidates = ("$here/node_modules/opencode-ai/package.json", "$here/../lib/node_modules/opencode-ai/package.json");
    my $folder = dirname($real);
    for (1 .. 3) { push @candidates, "$folder/package.json"; $folder = dirname($folder) }
    for my $path (@candidates) {
        my $package = read_object($path) or next;
        my $name = obj_get($package, 'name');
        return obj_get($package, 'version') if is_str($name) && ($name eq 'opencode-ai' || $name eq 'opencode');
    }
    return undef;
}
sub binary_version {
    # OpenCode binaries end with their build flags, which include the version
    # (for example --user-agent=opencode/latest/2.2.7). Only that tail is read.
    my ($path) = @_;
    open(my $handle, '<', $path) or return undef;
    binmode $handle;
    my $size = -s $handle;
    return undef unless defined $size && !-d $handle;
    my $limit = 8 * 1024 * 1024;
    seek($handle, $size > $limit ? $size - $limit : 0, 0);
    my $tail = do { local $/; <$handle> };
    close $handle;
    return defined $tail && $tail =~ m{--user-agent=opencode/(?:[^/\s]+/)?([0-9]+\.[0-9]+\.[0-9]+)} ? $1 : undef;
}
sub home { defined $ENV{HOME} && length $ENV{HOME} ? $ENV{HOME} : ((getpwuid($<))[7] || '/') }
sub detect_opencode {
    # Returns the config format to write (1 or 2) and a description of why.
    my ($requested) = @_;
    if (defined $requested && length $requested) {
        fail('--opencode-version must be 1 or 2.') unless $requested eq '1' || $requested eq '2';
        return ($requested + 0, 'as requested');
    }
    my $home = home();
    my @found;
    # The OpenCode 2 background service records its version; OpenCode 1 has no service.
    my $state_home = defined $ENV{XDG_STATE_HOME} && length $ENV{XDG_STATE_HOME} ? $ENV{XDG_STATE_HOME} : "$home/.local/state";
    if (my $service = read_object("$state_home/opencode/service.json")) {
        my ($major, $version) = version_major(obj_get($service, 'version'));
        push @found, [$major, "OpenCode $version"] if defined $major;
    }
    # The desktop app keeps its bundled CLI in a folder named after its version.
    my @desktop;
    for my $root ("$home/Library/Application Support", "$home/.local/share", defined $ENV{XDG_DATA_HOME} ? $ENV{XDG_DATA_HOME} : '') {
        next unless length $root;
        opendir(my $folder, "$root/ai.opencode.desktop/cli") or next;
        for my $name (grep { !/\A\./ } readdir $folder) {
            my ($major, $version) = version_major($name);
            push @desktop, [$major, $version] if defined $major;
        }
        closedir $folder;
    }
    if (@desktop) {
        my ($latest) = sort { my @left = split /\./, $a->[1]; my @right = split /\./, $b->[1]; $right[0] <=> $left[0] || $right[1] <=> $left[1] || $right[2] <=> $left[2] } @desktop;
        push @found, [$latest->[0], "OpenCode Desktop $latest->[1]"];
    }
    my $command = which('opencode');
    my @binaries = ("$home/.opencode/bin/opencode");
    unshift @binaries, (Cwd::realpath($command) || $command) if defined $command;
    my ($major, $version) = defined $command ? version_major(package_version($command)) : ();
    for my $binary (@binaries) { ($major, $version) = version_major(binary_version($binary)) unless defined $major }
    push @found, [$major, "OpenCode $version"] if defined $major;
    if (@found) {
        my %names = map { $_->[1] => 1 } @found;
        # The OpenCode 1 format also loads in OpenCode 2, so it wins when both are found.
        return ((grep { $_->[0] < 2 } @found) ? 1 : 2, 'found ' . join(', ', sort keys %names));
    }
    return (1, 'found OpenCode of unknown version; this format works in OpenCode 1 and 2. For OpenCode 2, rerun with --opencode-version=2')
        if defined $command || -f "$home/.opencode/bin/opencode";
    return (2, 'OpenCode was not found; assuming OpenCode 2. For OpenCode 1, rerun with --opencode-version=1');
}

# ---- The configuration
my @MANAGED_PROVIDER_OPTIONS = qw(baseURL apiKey timeout chunkTimeout);
my @OPENCODE2_PROVIDER_KEYS = qw(canonical env compatibility headers body);
sub remove_provider_entry {
    my ($config, $key) = @_;
    my $container = obj_get($config, $key);
    return undef unless is_obj($container) && obj_has($container, 'ieti-agents');
    my $removed = obj_del($container, 'ieti-agents');
    obj_del($config, $key) unless obj_keys($container);
    return is_obj($removed) ? $removed : undef;
}
sub extra_options {
    my ($entry, $key) = @_;
    my $values = field($entry, $key);
    my $extra = obj();
    return $extra unless is_obj($values);
    for my $name (obj_keys($values)) { obj_set($extra, $name, obj_get($values, $name)) unless grep { $_ eq $name } @MANAGED_PROVIDER_OPTIONS }
    return $extra;
}
sub update { my ($target, $source) = @_; obj_set($target, $_, obj_get($source, $_)) for obj_keys($source); $target }
sub ieti_provider {
    my ($config) = @_;
    for my $key (qw(providers provider)) {
        my $container = field($config, $key);
        return obj_get($container, 'ieti-agents') if is_obj($container) && is_obj(obj_get($container, 'ieti-agents'));
    }
    return undef;
}
sub without_ieti { [ grep { !(is_str($_) && $_ eq 'ieti-agents') } @{ $_[0] } ] }
sub prepare {
    my ($config_path, $catalog_path, $output_path, $base_url, $key_path, $action, $major) = @_;
    $major = '2' unless defined $major;
    my $original = snapshot($config_path);
    my $config = read_config($config_path, $original);
    my $original_json = dump_json($config);
    if ($action eq 'uninstall') {
        for my $key (qw(provider providers)) { obj_del(obj_get($config, $key), 'ieti-agents') if is_obj(obj_get($config, $key)) }
        for my $selection (qw(model small_model)) { obj_del($config, $selection) if starts_with(obj_get($config, $selection), 'ieti-agents/') }
        if (is_obj(obj_get($config, 'agent'))) {
            for my $name (obj_keys(obj_get($config, 'agent'))) {
                my $agent = obj_get(obj_get($config, 'agent'), $name);
                obj_del($agent, 'model') if is_obj($agent) && starts_with(obj_get($agent, 'model'), 'ieti-agents/');
            }
        }
        for my $selection (qw(enabled_providers disabled_providers)) {
            obj_set($config, $selection, without_ieti(obj_get($config, $selection))) if is_arr(obj_get($config, $selection));
        }
    } else {
        fail("invalid literal for int() with base 10: '$major'") unless $major =~ /\A\s*[+-]?[0-9]+\s*\z/;
        $major += 0;
        my $models = models_from_catalog($catalog_path, $major);
        obj_set($config, '$schema', 'https://opencode.ai/config.json') unless truthy(obj_get($config, '$schema'));
        (my $key_reference = $key_path) =~ tr{\\}{/};
        my $api_key = "{file:$key_reference}";
        if ($major >= 2) {
            # OpenCode 2 reads "providers"; an entry left in the deprecated
            # "provider" block would be merged with it, so it moves here.
            my $legacy = remove_provider_entry($config, 'provider');
            obj_set($config, providers => obj()) unless is_obj(obj_get($config, 'providers'));
            my $existing = obj_get(obj_get($config, 'providers'), 'ieti-agents');
            $existing = obj() unless is_obj($existing);
            my $provider = obj();
            for my $key (obj_keys($existing)) { obj_set($provider, $key, obj_get($existing, $key)) if grep { $_ eq $key } @OPENCODE2_PROVIDER_KEYS }
            my $settings = extra_options($legacy, 'options');
            update($settings, extra_options($existing, 'settings'));
            # OpenCode 2 waits 15 minutes between streamed chunks by default.
            update($settings, obj(baseURL => $base_url, apiKey => $api_key, timeout => number('900000')));
            update($provider, obj(name => 'IETI Agents', package => '@opencode/ai/providers/openai-compatible', settings => $settings, models => $models));
            obj_set(obj_get($config, 'providers'), 'ieti-agents', $provider);
        } else {
            my $current = remove_provider_entry($config, 'providers');
            obj_set($config, provider => obj()) unless is_obj(obj_get($config, 'provider'));
            my $existing = obj_get(obj_get($config, 'provider'), 'ieti-agents');
            my $provider = update(obj(), is_obj($existing) ? $existing : obj());
            my $options = extra_options($current, 'settings');
            update($options, obj_get($provider, 'options')) if is_obj(obj_get($provider, 'options'));
            update($options, obj(baseURL => $base_url, apiKey => $api_key, timeout => number('900000'), chunkTimeout => number('600000')));
            update($provider, obj(npm => '@ai-sdk/openai-compatible', name => 'IETI Agents', options => $options, models => $models));
            obj_set(obj_get($config, 'provider'), 'ieti-agents', $provider);
        }
        my $enabled = obj_get($config, 'enabled_providers');
        push @$enabled, 'ieti-agents' if is_arr($enabled) && !grep { is_str($_) && $_ eq 'ieti-agents' } @$enabled;
        obj_set($config, disabled_providers => without_ieti(obj_get($config, 'disabled_providers'))) if is_arr(obj_get($config, 'disabled_providers'));
        my $selected = obj_has($config, 'model') ? obj_get($config, 'model') : '';
        $selected = '' unless is_str($selected);
        my $selected_ieti = starts_with($selected, 'ieti-agents/') ? substr($selected, length 'ieti-agents/') : '';
        obj_set($config, model => 'ieti-agents/' . (obj_keys($models))[0]) if !length($selected) || (length($selected_ieti) && !obj_has($models, $selected_ieti));
    }
    my $contents = $action eq 'uninstall' && exists_in($original) && $original_json eq dump_json($config)
        ? original_bytes($original)
        : Encode::encode('UTF-8', dump_json($config, 2) . "\n");
    write_private($output_path, $contents);
    write_json("$output_path.source", $original);
    write_json("$output_path.key-source", snapshot($key_path)) unless -e "$output_path.key-source";
}

# ---- Saving: everything is staged first, then moved into place, and undone if a step fails
sub make_directories {
    my ($directory, $created) = @_;
    my (@missing, $current);
    $current = absolute($directory);
    while (!-e $current) { push @missing, $current; $current = dirname($current) }
    for my $destination (reverse @missing) {
        if (mkdir $destination, 0700) { push @$created, $destination }
        elsif (!($!{EEXIST} && -d $destination)) { os_fail($destination) }
    }
}
sub cleanup_directories {
    my ($plan) = @_;
    # Successful configuration or another process may now own contents: a folder that is
    # not empty, or already gone, is left alone.
    rmdir $_ for reverse @{ obj_get($plan, 'createdDirectories') || [] };
}
sub stage {
    my ($config_path, $prepared_path, $key_path, $candidate_path, $manifest_path, $action) = @_;
    my $original_config = read_json("$prepared_path.source");
    fail('Configuration changed during setup. Run the installer again.') unless same(snapshot($config_path), $original_config);
    my $original_key = read_json("$prepared_path.key-source");
    fail('API key changed during setup. Run the installer again.') unless same(snapshot($key_path), $original_key);
    my $contents = read_bytes($prepared_path);
    my $config_changed = ($action ne 'uninstall' || exists_in($original_config))
        && (!exists_in($original_config) || original_bytes($original_config) ne $contents);
    my $candidate = $action ne 'uninstall' ? read_bytes($candidate_path) : undef;
    my $key_changed = $action eq 'uninstall' ? exists_in($original_key)
        : (!exists_in($original_key) || original_bytes($original_key) ne $candidate || ${ obj_get($original_key, 'mode') } != 0600);
    my $backup_path = "$config_path.bak";
    my $plan = obj(configPath => $config_path, keyPath => $key_path, backupPath => $backup_path, action => $action,
        preparedPath => $prepared_path, candidatePath => $candidate_path, originalConfig => $original_config,
        originalKey => $original_key, configChanged => boolean($config_changed), keyChanged => boolean($key_changed),
        originalBackup => ($config_changed && exists_in($original_config) ? snapshot($backup_path) : undef),
        stages => [], createdDirectories => []);
    my $staged = eval {
        if ($config_changed) {
            make_directories(dirname($config_path), obj_get($plan, 'createdDirectories'));
            obj_set($plan, configStage => temporary($config_path));
            push @{ obj_get($plan, 'stages') }, obj_get($plan, 'configStage');
            if (exists_in($original_config)) {
                obj_set($plan, backupStage => temporary($backup_path));
                push @{ obj_get($plan, 'stages') }, obj_get($plan, 'backupStage');
            }
        }
        obj_set($plan, keyRollback => "$key_path.tmp.rollback." . random_hex()) if $key_changed && exists_in($original_key);
        if ($key_changed && $action ne 'uninstall') {
            make_directories(dirname($key_path), obj_get($plan, 'createdDirectories'));
            chmod(0700, dirname($key_path)) or os_fail(dirname($key_path));
            obj_set($plan, keyStage => temporary($key_path));
            push @{ obj_get($plan, 'stages') }, obj_get($plan, 'keyStage');
        }
        write_json($manifest_path, $plan);
        1;
    };
    return if $staged;
    my $error = $@;
    eval { remove($_) } for @{ obj_get($plan, 'stages') };
    cleanup_directories($plan);
    die $error;
}
sub commit {
    my ($manifest_path) = @_;
    my $plan = read_json($manifest_path);
    my $get = sub { obj_get($plan, $_[0]) };
    my ($backup_written, $key_moved, $key_written, $config_written) = (0, 0, 0, 0);
    my $done = eval {
        fail('Configuration changed during setup. Run the installer again.')
            if !same(snapshot($get->('configPath')), $get->('originalConfig')) || !same(snapshot($get->('keyPath')), $get->('originalKey'))
            || (defined $get->('originalBackup') && !same(snapshot($get->('backupPath')), $get->('originalBackup')));
        write_private($get->('configStage'), read_bytes($get->('preparedPath'))) if truthy($get->('configStage'));
        write_private($get->('backupStage'), original_bytes($get->('originalConfig'))) if truthy($get->('backupStage'));
        write_private($get->('keyStage'), read_bytes($get->('candidatePath'))) if truthy($get->('keyStage'));
        if (truthy($get->('backupStage'))) { replace($get->('backupStage'), $get->('backupPath')); $backup_written = 1 }
        if (is_true($get->('keyChanged'))) {
            if (truthy($get->('keyRollback'))) { replace($get->('keyPath'), $get->('keyRollback')); $key_moved = 1 }
            if ($get->('action') ne 'uninstall') { replace($get->('keyStage'), $get->('keyPath')); $key_written = 1 }
        }
        if (truthy($get->('configStage'))) { replace($get->('configStage'), $get->('configPath')); $config_written = 1 }
        remove($get->('keyRollback'));
        print is_true($get->('configChanged')) || is_true($get->('keyChanged')) ? 'changed' : 'unchanged';
        1;
    };
    my $error = $@;
    unless ($done) {
        my $undone = eval {
            restore($get->('configPath'), $get->('originalConfig')) if $config_written;
            if ($key_moved) {
                if (-e $get->('keyRollback')) { replace($get->('keyRollback'), $get->('keyPath')) } else { restore($get->('keyPath'), $get->('originalKey')) }
            } elsif ($key_written) {
                restore($get->('keyPath'), $get->('originalKey'));
            }
            restore($get->('backupPath'), $get->('originalBackup')) if $backup_written;
            1;
        };
        my $rollback_error = $@;
        my $text = sub { ref($_[0]) eq 'HASH' ? $_[0]{message} : "$_[0]" };
        $error = { message => $text->($error) . ' Rollback failed: ' . $text->($rollback_error) } unless $undone;
    }
    eval { remove($_) } for @{ $get->('stages') };
    cleanup_directories($plan);
    die $error unless $done;
}

sub redact { my ($text) = @_; $text =~ s/ieti_sk_[A-Za-z0-9_-]+/[redacted key]/g; $text }
sub main {
    my ($operation, @args) = @_;
    if ($operation eq 'inspect-config') { print defined ieti_provider(read_config($args[0])) ? '1' : '0' }
    elsif ($operation eq 'detect-opencode') { my ($major, $reason) = detect_opencode($args[0]); print "$major\t$reason" }
    elsif ($operation eq 'snapshot-key') { write_json($args[1], snapshot($args[0])) }
    elsif ($operation eq 'normalize') { print normalize_url($args[0]) }
    elsif ($operation eq 'fetch') { fetch(@args) }
    elsif ($operation eq 'error') {
        my $message = eval {
            my $body = read_json($args[0]);
            my $error = is_obj($body) && obj_has($body, 'error') ? obj_get($body, 'error') : obj();
            my $text = field($error, 'message');
            $text = field($body, 'message') unless truthy($text);
            truthy($text) ? (is_str($text) ? $text : dump_json($text)) : undef;
        };
        print redact(defined $message ? $message : 'the server rejected the request');
    }
    elsif ($operation eq 'prepare') { prepare(@args) }
    elsif ($operation eq 'stage') { stage(@args) }
    elsif ($operation eq 'commit') { commit(@args) }
    elsif ($operation eq 'cleanup') {
        if (-e $args[0]) {
            my $plan = read_json($args[0]);
            remove($_) for @{ obj_get($plan, 'stages') };
            cleanup_directories($plan);
        }
    }
    elsif ($operation eq 'absolute') { print absolute($args[0]) }
    elsif ($operation eq 'read-key') { print read_key($args[0]) }
    elsif ($operation eq 'model-count') { print scalar obj_keys(obj_get(ieti_provider(read_json($args[0])), 'models')) }
    else { fail('Unknown installer operation.') }
}

$SIG{INT} = sub { print STDERR "Setup cancelled. Existing configuration was kept.\n"; POSIX::_exit(130) };
binmode STDOUT, ':encoding(UTF-8)';
binmode STDERR, ':encoding(UTF-8)';
my @arguments = map { my $argument = $_; my $text = eval { Encode::decode('UTF-8', $argument, Encode::FB_CROAK) }; defined $text ? $text : $_ } @ARGV;
unless (eval { fail('Perl 5.16 or newer is required.') if $] < 5.016; main(@arguments); 1 }) {
    my $message = ref($@) eq 'HASH' ? $@->{message} : "$@";
    $message =~ s/ at -e line [0-9]+\.?\s*\z//;
    $message =~ s/\s+\z//;
    print STDERR 'Error: ' . redact($message) . "\n";
    exit 1;
}
